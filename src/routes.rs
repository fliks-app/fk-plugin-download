//! The 39 proxied routes. Bodies and statuses are the TypeScript plugin's, frozen by its tests.

use crate::db::{HistoryRow, blocklist, clients, history, indexer_stats};
use crate::error::{Error, R};
use crate::grab::{self, Manual, Stream, to_wire};
use crate::util::{Settings, js_number, num};
use crate::{client, indexers, poller, sources};
use fliks_plugin_sdk::bindings::fliks::plugin::types::{AcquisitionEvent, Principal, ResolveQuery};
use fliks_plugin_sdk::host;
use fliks_plugin_sdk::router::{Handler, Request, Response, Router};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::LazyLock;

fn ok(v: impl serde::Serialize) -> R<Response> {
    Ok(Response::json(200, &v))
}

fn err_body(status: u16, key: &str, detail: Option<&str>) -> Response {
    let mut e = json!({ "key": key });
    if let Some(d) = detail {
        e["detail"] = json!(d);
    }
    Response::json(status, &json!({ "error": e }))
}

fn bad_param(p: &str) -> R<Response> {
    Ok(err_body(400, "download.http.errors.bad_param", Some(p)))
}

fn bad_body(field: &str) -> R<Response> {
    Ok(err_body(400, "download.http.errors.bad_body", Some(field)))
}

fn not_found(detail: &str) -> R<Response> {
    Ok(err_body(
        404,
        "download.http.errors.not_found",
        Some(detail),
    ))
}

/// A domain error as its structured, i18n-keyed answer.
pub fn respond(r: R<Response>) -> Response {
    match r {
        Ok(r) => r,
        Err(Error::Grab { key, detail }) => {
            let status = if key == "download.grab.errors.media_not_found" {
                404
            } else {
                409
            };
            err_body(status, key, detail.as_deref())
        }
        Err(Error::NotFound(m)) => err_body(404, "download.http.errors.not_found", Some(&m)),
        Err(Error::UnknownImplementation(_)) => {
            err_body(400, "download.http.errors.bad_body", Some("implementation"))
        }
        Err(Error::Source {
            key,
            detail,
            message,
        }) => {
            error!("indexer source import refused: {message}");
            err_body(400, key, detail.as_deref())
        }
        Err(Error::Client(m)) => {
            error!("download client refused the request: {m}");
            err_body(502, "download.http.errors.download_client", Some(&m))
        }
        Err(e) => {
            error!("http handler failed: {e}");
            err_body(500, "download.http.errors.internal", Some(&e.to_string()))
        }
    }
}

fn body(r: &Request) -> Map<String, Value> {
    match serde_json::from_slice(&r.body) {
        Ok(Value::Object(o)) => o,
        _ => Map::new(),
    }
}

/// A canonical positive integer, as core's object guard requires of `:id`.
fn int_param(r: &Request, name: &str) -> Option<Option<u32>> {
    let v = r.param(name)?;
    let valid = !v.is_empty() && !v.starts_with('0') && v.bytes().all(|b| b.is_ascii_digit());
    Some(if valid { v.parse().ok() } else { None })
}

fn id(r: &Request) -> Result<u32, R<Response>> {
    int_param(r, "id").flatten().ok_or_else(|| bad_param("id"))
}

macro_rules! need_id {
    ($r:expr) => {
        match id($r) {
            Ok(i) => i64::from(i),
            Err(resp) => return resp,
        }
    };
}

/// `Math.max(1, Math.trunc(Number(raw)) || fallback)`.
fn page_number(raw: Option<&str>, fallback: i64) -> i64 {
    let n = js_number(raw.map(|s| Value::String(s.into())).as_ref()).trunc();
    let n = if n.is_nan() || n == 0.0 {
        fallback as f64
    } else {
        n
    };
    n.max(1.0) as i64
}

fn page_size(raw: Option<&str>) -> i64 {
    page_number(raw, 25).min(100)
}

fn str_field(b: &Map<String, Value>, k: &str) -> Option<String> {
    b.get(k).and_then(Value::as_str).map(str::to_owned)
}
fn num_field(b: &Map<String, Value>, k: &str) -> Option<f64> {
    b.get(k).and_then(Value::as_f64)
}
fn bool_field(b: &Map<String, Value>, k: &str) -> Option<bool> {
    b.get(k).and_then(Value::as_bool)
}
fn settings_field(b: &Map<String, Value>) -> Option<Settings> {
    b.get("settings").and_then(Value::as_object).cloned()
}

// --- releases ------------------------------------------------------------------------------

fn scope(r: &Request) -> Result<(u32, Option<u32>, Option<u32>), R<Response>> {
    let media = id(r)?;
    let season = match int_param(r, "seasonId") {
        Some(None) => return Err(bad_param("seasonId")),
        s => s.flatten(),
    };
    let episode = match int_param(r, "episodeId") {
        Some(None) => return Err(bad_param("episodeId")),
        e => e.flatten(),
    };
    Ok((media, season, episode))
}

fn search_releases(r: &Request) -> R<Response> {
    let (media, season, episode) = match scope(r) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    // Only a delegated viewer with a modal open (`sid`) gets the streamed partial results.
    let stream = match (&r.principal, r.query("sid")) {
        (Principal::Delegated(user), Some(sid)) if !sid.is_empty() => Some(Stream {
            user_id: *user,
            search_id: sid.to_owned(),
        }),
        _ => None,
    };
    let releases = grab::search_releases(media, season, episode, r.query("q"), stream.as_ref())?;
    ok(releases.iter().map(to_wire).collect::<Vec<_>>())
}

/// Only an absolute http(s) URL is kept: it reaches a browser as an anchor.
fn info_url(raw: Option<&Value>) -> Option<String> {
    let s = raw?.as_str().filter(|s| !s.is_empty())?;
    let u = url::Url::parse(s).ok()?;
    matches!(u.scheme(), "http" | "https").then(|| s.to_owned())
}

fn grab_release(r: &Request) -> R<Response> {
    let (media, season, episode) = match scope(r) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let who = match r.principal {
        Principal::Delegated(u) => format!("user #{u}"),
        Principal::System => "system".into(),
    };
    info!("grab http request for media #{media} by {who}");
    let b = body(r);
    let manual = str_field(&b, "downloadUrl")
        .filter(|u| !u.is_empty())
        .map(|download_url| Manual {
            download_url,
            source_title: str_field(&b, "sourceTitle"),
            indexer_id: num_field(&b, "sourceId").map(|f| f as i64),
            info_url: info_url(b.get("infoUrl")),
            force: b.get("force") == Some(&Value::Bool(true)),
        });
    ok(grab::grab_release(media, season, episode, manual)?)
}

// --- indexers ------------------------------------------------------------------------------

enum Gates {
    Ok(Option<bool>, Option<bool>, Option<bool>),
    Empty,
    Invalid,
}

/// `useFor` wins over the three booleans: a save body spreads the row the client last read.
fn gates(b: &Map<String, Value>) -> Gates {
    match b.get("useFor") {
        Some(Value::Array(a)) if a.is_empty() => Gates::Empty,
        Some(Value::Array(a))
            if a.iter()
                .all(|v| v.as_str().is_some_and(|s| indexers::USE_FOR.contains(&s))) =>
        {
            let has = |k: &str| Some(a.iter().any(|v| v == k));
            Gates::Ok(has("rss"), has("auto"), has("manual"))
        }
        Some(_) => Gates::Invalid,
        None => Gates::Ok(
            bool_field(b, "enableRss"),
            bool_field(b, "enableSearch"),
            bool_field(b, "enableInteractiveSearch"),
        ),
    }
}

fn indexer_input(b: &Map<String, Value>) -> Result<indexers::Input, R<Response>> {
    let (rss, search, interactive) = match gates(b) {
        Gates::Ok(a, b, c) => (a, b, c),
        Gates::Empty => {
            return Err(Ok(err_body(
                400,
                "download.config.indexers.errors.no_usage",
                None,
            )));
        }
        Gates::Invalid => return Err(bad_body("useFor")),
    };
    Ok(indexers::Input {
        name: str_field(b, "name"),
        implementation: str_field(b, "implementation"),
        settings: settings_field(b),
        enable_rss: rss,
        enable_search: search,
        enable_interactive_search: interactive,
        priority: num_field(b, "priority"),
        request_delay: num_field(b, "requestDelay"),
        enabled: bool_field(b, "enabled"),
    })
}

/// `'name'`/`'implementation'` when either is missing on a create.
fn required(b: &Map<String, Value>) -> Option<&'static str> {
    if str_field(b, "name").is_none_or(|n| n.trim().is_empty()) {
        return Some("name");
    }
    if str_field(b, "implementation").is_none_or(|i| i.is_empty()) {
        return Some("implementation");
    }
    None
}

fn list_indexers(_: &Request) -> R<Response> {
    ok(indexers::list()?)
}

fn create_indexer(r: &Request) -> R<Response> {
    let b = body(r);
    if let Some(f) = required(&b) {
        return bad_body(f);
    }
    let input = match indexer_input(&b) {
        Ok(i) => i,
        Err(resp) => return resp,
    };
    Ok(Response::json(201, &indexers::create(input)?))
}

fn update_indexer(r: &Request) -> R<Response> {
    let id = need_id!(r);
    let input = match indexer_input(&body(r)) {
        Ok(i) => i,
        Err(resp) => return resp,
    };
    ok(indexers::update(id, input)?)
}

fn delete_indexer(r: &Request) -> R<Response> {
    let id = need_id!(r);
    indexers::remove(id)?;
    ok(json!({}))
}

/// `(implementation, settings, id)` of a test-connection body.
fn test_input(r: &Request) -> Option<(String, Settings, Option<i64>)> {
    let b = body(r);
    let implementation = str_field(&b, "implementation")?;
    let id = b.get("id").and_then(Value::as_i64);
    Some((implementation, settings_field(&b).unwrap_or_default(), id))
}

fn test_indexer(r: &Request) -> R<Response> {
    let Some((i, s, id)) = test_input(r) else {
        return bad_body("implementation");
    };
    ok(indexers::test_connection(&i, &s, id))
}

fn indexer_stats(r: &Request) -> R<Response> {
    let id = need_id!(r);
    ok(indexer_stats::daily(id)?)
}

fn clear_cooldown(r: &Request) -> R<Response> {
    let id = need_id!(r);
    ok(indexers::clear_cooldown(id)?)
}

fn clear_cooldowns(_: &Request) -> R<Response> {
    ok(indexers::clear_all_cooldowns()?)
}

// --- indexer sources -----------------------------------------------------------------------

fn source_input(b: &Map<String, Value>) -> sources::Input {
    sources::Input {
        name: str_field(b, "name"),
        implementation: str_field(b, "implementation"),
        settings: settings_field(b),
        priority: num_field(b, "priority"),
        enabled: bool_field(b, "enabled"),
    }
}

fn list_sources(_: &Request) -> R<Response> {
    ok(crate::db::indexer_sources::list_all()?
        .iter()
        .map(sources::redact)
        .collect::<Vec<_>>())
}

fn create_source(r: &Request) -> R<Response> {
    let b = body(r);
    if let Some(f) = required(&b) {
        return bad_body(f);
    }
    Ok(Response::json(201, &sources::create(source_input(&b))?))
}

fn update_source(r: &Request) -> R<Response> {
    let id = need_id!(r);
    ok(sources::update(id, source_input(&body(r)))?)
}

fn delete_source(r: &Request) -> R<Response> {
    let id = need_id!(r);
    sources::remove(id)?;
    ok(json!({}))
}

fn test_source(r: &Request) -> R<Response> {
    let Some((i, s, id)) = test_input(r) else {
        return bad_body("implementation");
    };
    ok(sources::test_connection(&i, &s, id))
}

fn import_source(r: &Request) -> R<Response> {
    let id = need_id!(r);
    ok(sources::import(id)?)
}

// --- download clients ----------------------------------------------------------------------

fn client_input(b: &Map<String, Value>) -> client::Input {
    client::Input {
        name: str_field(b, "name"),
        implementation: str_field(b, "implementation"),
        settings: settings_field(b),
        enabled: bool_field(b, "enabled"),
        priority: num_field(b, "priority"),
    }
}

fn list_clients(_: &Request) -> R<Response> {
    ok(clients::list_all()?
        .iter()
        .map(client::redact)
        .collect::<Vec<_>>())
}

fn create_client(r: &Request) -> R<Response> {
    let b = body(r);
    if let Some(f) = required(&b) {
        return bad_body(f);
    }
    Ok(Response::json(201, &client::create(client_input(&b))?))
}

fn update_client(r: &Request) -> R<Response> {
    let id = need_id!(r);
    ok(client::update(id, client_input(&body(r)))?)
}

fn delete_client(r: &Request) -> R<Response> {
    let id = need_id!(r);
    client::remove(id)?;
    ok(json!({}))
}

fn test_client(r: &Request) -> R<Response> {
    let Some((i, s, id)) = test_input(r) else {
        return bad_body("implementation");
    };
    ok(client::test(&i, &s, id))
}

// --- blocklist -----------------------------------------------------------------------------

fn list_blocklist(r: &Request) -> R<Response> {
    let page = page_number(r.query("page"), 1);
    let size = page_size(r.query("pageSize"));
    let (items, total) = blocklist::list(size, (page - 1) * size)?;
    ok(json!({ "data": items, "total": total, "page": page, "pageSize": size }))
}

fn clear_blocklist(_: &Request) -> R<Response> {
    blocklist::clear()?;
    ok(json!({}))
}

fn remove_blocklist(r: &Request) -> R<Response> {
    let id = need_id!(r);
    if blocklist::find(id)?.is_none() {
        return not_found(&id.to_string());
    }
    blocklist::remove(id)?;
    ok(json!({}))
}

// --- queue and history ---------------------------------------------------------------------

struct ClientIndex {
    consulted: bool,
    ok: bool,
    by_hash: HashMap<String, client::Torrent>,
}

/// One entry per known client, enabled or not, so "never asked" reads apart from "no answer".
fn index_clients() -> R<(HashMap<i64, ClientIndex>, bool)> {
    let mut out = HashMap::new();
    let mut unreachable = false;
    for c in clients::list_all()? {
        if !c.enabled
            || !client::IMPLEMENTATIONS.contains(&c.implementation.as_str())
            || !client::supports(&c)
        {
            out.insert(
                c.id,
                ClientIndex {
                    consulted: false,
                    ok: false,
                    by_hash: HashMap::new(),
                },
            );
            continue;
        }
        let (ok, ts) = client::torrents(&c);
        unreachable |= !ok;
        out.insert(
            c.id,
            ClientIndex {
                consulted: true,
                ok,
                by_hash: ts.into_iter().map(|t| (t.hash.to_lowercase(), t)).collect(),
            },
        );
    }
    Ok((out, unreachable))
}

fn live<'a>(row: &HistoryRow, idx: &'a HashMap<i64, ClientIndex>) -> Option<&'a client::Torrent> {
    let i = idx.get(&row.download_client_id?)?;
    i.by_hash.get(&row.torrent_hash.as_ref()?.to_lowercase())
}

fn unverifiable(row: &HistoryRow, idx: &HashMap<i64, ClientIndex>) -> bool {
    if row.status == "importing" || row.status == "import_failed" {
        return false;
    }
    let (Some(c), Some(_)) = (
        row.download_client_id,
        row.torrent_hash.as_ref().filter(|h| !h.is_empty()),
    ) else {
        return false;
    };
    idx.get(&c).is_none_or(|i| !i.consulted || !i.ok)
}

fn indexer_names() -> R<HashMap<i64, String>> {
    Ok(crate::db::indexers::list_all()?
        .into_iter()
        .map(|ix| (ix.id, ix.name))
        .collect())
}

fn base_item(row: &HistoryRow, names: &HashMap<i64, String>) -> Map<String, Value> {
    let mut o = Map::new();
    o.insert("id".into(), json!(row.id));
    o.insert("title".into(), json!(row.source_title));
    o.insert("sourceTitle".into(), json!(row.source_title));
    o.insert("quality".into(), json!(row.quality));
    o.insert("grabSource".into(), json!(row.grab_source));
    o.insert("date".into(), json!(row.created_at));
    o.insert("infoUrl".into(), json!(row.info_url));
    o.insert(
        "source".into(),
        json!(
            row.indexer_id
                .and_then(|i| names.get(&i))
                .cloned()
                .unwrap_or_default()
        ),
    );
    o.insert("mediaId".into(), json!(row.media_id));
    o.insert("seasonId".into(), json!(row.season_id));
    o.insert("episodeId".into(), json!(row.episode_id));
    o.insert("mediaType".into(), Value::Null);
    o.insert("statusMessage".into(), Value::Null);
    o
}

fn size_or_null(s: Option<i64>) -> Value {
    s.filter(|s| *s != 0).map_or(Value::Null, |s| json!(s))
}

fn queue_item(
    row: &HistoryRow,
    idx: &HashMap<i64, ClientIndex>,
    names: &HashMap<i64, String>,
) -> Option<Map<String, Value>> {
    let mut o = base_item(row, names);
    let mut set = |vals: &[(&str, Value)]| {
        for (k, v) in vals {
            o.insert((*k).into(), v.clone());
        }
    };
    if row.status == "import_failed" {
        set(&[
            ("state", json!("import_failed")),
            ("statusMessage", json!(row.status_message)),
            ("progress", json!(100)),
            ("bytesPerSecond", Value::Null),
            ("size", size_or_null(row.size)),
            ("clientReachable", json!(true)),
        ]);
    } else if row.status == "importing" {
        set(&[
            ("state", json!("importing")),
            ("progress", json!(100)),
            ("bytesPerSecond", Value::Null),
            ("size", Value::Null),
            ("clientReachable", json!(true)),
        ]);
    } else if let Some(t) = live(row, idx) {
        set(&[
            ("state", json!(client::progress_state(&t.state))),
            ("progress", num(t.progress * 100.0)),
            ("bytesPerSecond", num(t.dlspeed)),
            ("size", size_or_null(Some(t.size))),
            ("clientReachable", json!(true)),
        ]);
    } else if row.download_client_id.is_none()
        || row.torrent_hash.as_deref().is_none_or(str::is_empty)
    {
        // Never reached a client: that is what queued means.
        set(&[
            ("state", json!("queued")),
            ("progress", Value::Null),
            ("bytesPerSecond", Value::Null),
            ("size", Value::Null),
            ("clientReachable", json!(true)),
        ]);
    } else {
        return None;
    }
    Some(o)
}

/// A film's title, or "Show - S01E02", from one id per row (within `media.resolve`'s 100).
fn attach_labels(items: &mut [Map<String, Value>]) -> R<()> {
    let key = |o: &Map<String, Value>| -> Option<(&'static str, u32)> {
        for (field, kind) in [
            ("episodeId", "episode"),
            ("seasonId", "season"),
            ("mediaId", "media"),
        ] {
            if let Some(i) = o
                .get(field)
                .and_then(Value::as_u64)
                .and_then(|i| u32::try_from(i).ok())
            {
                return Some((kind, i));
            }
        }
        None
    };
    let keys: Vec<Option<(&str, u32)>> = items.iter().map(key).collect();
    let mut q = ResolveQuery {
        media_ids: vec![],
        season_ids: vec![],
        episode_ids: vec![],
    };
    for (kind, i) in keys.iter().flatten() {
        let list = match *kind {
            "episode" => &mut q.episode_ids,
            "season" => &mut q.season_ids,
            _ => &mut q.media_ids,
        };
        if !list.contains(i) {
            list.push(*i);
        }
    }
    if q.media_ids.is_empty() && q.season_ids.is_empty() && q.episode_ids.is_empty() {
        return Ok(());
    }
    let resolved: HashMap<String, _> = host::media_resolve(&q)?.into_iter().collect();
    for (item, k) in items.iter_mut().zip(keys) {
        let Some(hit) = k.and_then(|(kind, i)| resolved.get(&format!("{kind}:{i}"))) else {
            continue;
        };
        let suffix = match (hit.season_number, hit.episode_number) {
            (None, _) => String::new(),
            (Some(s), None) => format!("S{s:02}"),
            (Some(s), Some(e)) => format!("S{s:02}E{e:02}"),
        };
        let title = if suffix.is_empty() {
            hit.title.clone()
        } else {
            format!("{} - {suffix}", hit.title)
        };
        item.insert("title".into(), json!(title));
        item.insert("mediaType".into(), json!(grab::kind_str(hit.kind)));
    }
    Ok(())
}

const HISTORY_STATUSES: [&str; 6] = [
    "grabbed",
    "importing",
    "completed",
    "failed",
    "import_failed",
    "warning",
];

fn queue(r: &Request) -> R<Response> {
    let page = page_number(r.query("page"), 1);
    let size = page_size(r.query("pageSize"));
    let rows = history::by_statuses(&["grabbed", "importing", "import_failed"])?;
    let (idx, unreachable) = index_clients()?;
    let names = indexer_names()?;
    let mut items: Vec<Map<String, Value>> = rows
        .iter()
        .filter_map(|row| queue_item(row, &idx, &names))
        .collect();
    items.sort_by_key(|o| std::cmp::Reverse(o["id"].as_i64().unwrap_or(0)));
    let unverifiable = rows.iter().filter(|row| unverifiable(row, &idx)).count();
    let total = items.len();
    let start = ((page - 1) * size) as usize;
    let mut data: Vec<Map<String, Value>> =
        items.into_iter().skip(start).take(size as usize).collect();
    attach_labels(&mut data)?;
    ok(
        json!({ "data": data, "total": total, "page": page, "pageSize": size, "clientsUnreachable": unreachable || unverifiable > 0 }),
    )
}

/// A live row reads as its client reports it; `missing` when every client answered without it.
fn display_status(row: &HistoryRow, t: Option<&client::Torrent>, unreachable: bool) -> String {
    if row.status == "importing" {
        return "importing".into();
    }
    if let Some(t) = t {
        return client::progress_state(&t.state).into();
    }
    if !row.is_live() {
        return row.status.clone();
    }
    if !unreachable && row.torrent_hash.as_deref().is_some_and(|h| !h.is_empty()) {
        "missing".into()
    } else {
        row.status.clone()
    }
}

fn history_page(r: &Request) -> R<Response> {
    let page = page_number(r.query("page"), 1);
    let size = page_size(r.query("pageSize"));
    let q = r.query("q").map(str::trim).filter(|q| !q.is_empty());
    let status = r.query("status").filter(|s| HISTORY_STATUSES.contains(s));
    let (rows, total) = history::page(size, (page - 1) * size, q, status)?;
    let names = indexer_names()?;
    let (idx, unreachable) = index_clients()?;
    let mut data: Vec<Map<String, Value>> = rows
        .iter()
        .map(|row| {
            let t = if row.is_live() { live(row, &idx) } else { None };
            let state = match row.status.as_str() {
                s @ ("importing" | "import_failed") => json!(s),
                _ => t.map_or(Value::Null, |t| json!(client::progress_state(&t.state))),
            };
            let progress = if row.status == "importing" {
                json!(100)
            } else {
                t.map_or(Value::Null, |t| num(t.progress * 100.0))
            };
            let mut o = Map::new();
            o.insert("id".into(), json!(row.id));
            o.insert("date".into(), json!(row.created_at));
            o.insert("title".into(), json!(row.source_title));
            o.insert("sourceTitle".into(), json!(row.source_title));
            o.insert("quality".into(), json!(row.quality));
            o.insert("size".into(), size_or_null(row.size));
            o.insert("status".into(), json!(row.status));
            o.insert(
                "displayStatus".into(),
                json!(display_status(row, t, unreachable)),
            );
            o.insert("statusMessage".into(), json!(row.status_message));
            o.insert("grabSource".into(), json!(row.grab_source));
            o.insert(
                "source".into(),
                json!(
                    row.indexer_id
                        .and_then(|i| names.get(&i))
                        .cloned()
                        .unwrap_or_default()
                ),
            );
            o.insert("infoUrl".into(), json!(row.info_url));
            o.insert("state".into(), state);
            o.insert("progress".into(), progress);
            o.insert("mediaId".into(), json!(row.media_id));
            o.insert("seasonId".into(), json!(row.season_id));
            o.insert("episodeId".into(), json!(row.episode_id));
            o.insert("mediaType".into(), Value::Null);
            o
        })
        .collect();
    attach_labels(&mut data)?;
    ok(json!({ "data": data, "total": total, "page": page, "pageSize": size }))
}

/// Only a `grabbed` row can be controlled: an importing one's files are being moved.
fn controllable(r: &Request) -> Result<HistoryRow, R<Response>> {
    let id = id(r)?;
    let row = match history::find(id.into()) {
        Ok(Some(row)) => row,
        Ok(None) => return Err(not_found(&id.to_string())),
        Err(e) => return Err(Err(e)),
    };
    if row.status != "grabbed" {
        return Err(Ok(err_body(
            409,
            "download.queue.errors.not_controllable",
            Some(&row.status),
        )));
    }
    Ok(row)
}

fn settle(row: &HistoryRow, expect: poller::Outcome) {
    if let Err(e) = poller::settle_and_publish(row, expect) {
        warn!("progress publish failed: {e}");
    }
}

fn control(r: &Request, pause: bool) -> R<Response> {
    let row = match controllable(r) {
        Ok(row) => row,
        Err(resp) => return resp,
    };
    let (Some(client), Some(hash)) = (
        row.download_client_id,
        row.torrent_hash.clone().filter(|h| !h.is_empty()),
    ) else {
        return Ok(err_body(
            409,
            "download.queue.errors.no_torrent",
            Some(&row.id.to_string()),
        ));
    };
    let c = client::drivable(client)?;
    if pause {
        client::pause(&c, &hash)?
    } else {
        client::resume(&c, &hash)?
    }
    settle(&row, if pause { "paused" } else { "running" });
    ok(json!({}))
}

fn pause(r: &Request) -> R<Response> {
    control(r, true)
}

fn resume(r: &Request) -> R<Response> {
    control(r, false)
}

/// Removes the torrent when its client can be asked, and retires the row either way.
fn remove_queued(r: &Request) -> R<Response> {
    let row = match controllable(r) {
        Ok(row) => row,
        Err(resp) => return resp,
    };
    let (idx, _) = index_clients()?;
    let consulted = row
        .download_client_id
        .and_then(|c| idx.get(&c))
        .is_some_and(|i| i.consulted);
    match (
        consulted,
        row.download_client_id,
        row.torrent_hash.as_deref().filter(|h| !h.is_empty()),
    ) {
        (true, Some(client), Some(hash)) => {
            client::delete(
                &client::drivable(client)?,
                hash,
                r.query("deleteFiles") == Some("true"),
            )?;
            history::mark_failed(row.id, "download.queue.removed_by_user")?;
        }
        _ => history::mark_failed(row.id, "download.queue.retired_unverifiable")?,
    }
    settle(&row, "absent");
    ok(json!({}))
}

/// Hands a refused import back to the next `ImportCompleted` tick.
fn retry_import(r: &Request) -> R<Response> {
    let id = need_id!(r);
    if !history::retry_import(id)? {
        return match history::find(id)? {
            None => not_found(&id.to_string()),
            Some(row) => Ok(err_body(
                409,
                "download.queue.errors.not_retryable",
                Some(&row.status),
            )),
        };
    }
    if let Err(e) = host::events_publish(&[AcquisitionEvent::QueueChanged]) {
        warn!("queue-changed publish failed: {}", e.message);
    }
    ok(json!({}))
}

/// Refused while a client still holds the torrent: the row is its only link to the media.
fn delete_history(r: &Request) -> R<Response> {
    let id = need_id!(r);
    let Some(row) = history::find(id)? else {
        return not_found(&id.to_string());
    };
    if row.torrent_hash.as_deref().is_some_and(|h| !h.is_empty()) {
        let (idx, _) = index_clients()?;
        if live(&row, &idx).is_some() {
            return Ok(err_body(
                409,
                "download.config.history.errors.still_running",
                Some(&row.status),
            ));
        }
    }
    history::remove(id)?;
    ok(json!({}))
}

fn clear_history(_: &Request) -> R<Response> {
    ok(json!({ "removed": history::clear_terminal()? }))
}

// --- implementations -----------------------------------------------------------------------

static INDEXER_IMPLEMENTATIONS: LazyLock<Value> = LazyLock::new(|| {
    let f = "download.config.indexers.fields";
    json!([{
        "implementation": "torznab",
        "labelKey": "download.config.indexers.implementations.torznab",
        "fields": [
            { "key": "baseUrl", "type": "url", "labelKey": format!("{f}.base_url"), "required": true },
            { "key": "apiKey", "type": "password", "labelKey": format!("{f}.api_key"), "secret": true },
            { "key": "requestDelay", "type": "number", "labelKey": format!("{f}.request_delay"), "hint": format!("{f}.request_delay_hint"), "default": 2, "topLevel": true },
            {
                "key": "useFor", "type": "multiselect", "labelKey": format!("{f}.use_for"), "hint": format!("{f}.use_for_hint"),
                "required": true, "topLevel": true, "default": ["rss", "auto", "manual"],
                "options": [
                    { "value": "rss", "labelKey": format!("{f}.use_for_rss") },
                    { "value": "auto", "labelKey": format!("{f}.use_for_auto") },
                    { "value": "manual", "labelKey": format!("{f}.use_for_manual") },
                ],
            },
            { "key": "minSeeders", "type": "number", "labelKey": format!("{f}.min_seeders"), "default": 0 },
            { "key": "seedRatio", "type": "number", "labelKey": format!("{f}.seed_ratio"), "hint": format!("{f}.seed_ratio_hint"), "default": 1 },
            { "key": "maxRetentionDays", "type": "number", "labelKey": format!("{f}.max_retention_days"), "hint": format!("{f}.max_retention_days_hint") },
            { "key": "unknownLanguageIsoCode", "type": "text", "labelKey": format!("{f}.unknown_language"), "hint": format!("{f}.unknown_language_hint") },
        ],
    }])
});

static SOURCE_IMPLEMENTATIONS: LazyLock<Value> = LazyLock::new(|| {
    let def = |imp: &str| {
        json!({
            "implementation": imp,
            "labelKey": format!("download.config.indexer_sources.implementations.{imp}"),
            "fields": [
                { "key": "baseUrl", "type": "url", "labelKey": "download.config.indexer_sources.fields.base_url", "required": true },
                { "key": "apiKey", "type": "password", "labelKey": "download.config.indexer_sources.fields.api_key", "secret": true, "required": true },
            ],
        })
    };
    json!([def("prowlarr"), def("jackett")])
});

static CLIENT_IMPLEMENTATIONS: LazyLock<Value> = LazyLock::new(|| {
    let f = "download.config.download_clients.fields";
    let def = |imp: &str, port: u16, url_base: Option<&str>| {
        let mut fields = vec![
            json!({ "key": "host", "type": "text", "labelKey": format!("{f}.host"), "required": true, "default": "localhost" }),
            json!({ "key": "port", "type": "number", "labelKey": format!("{f}.port"), "default": port }),
            json!({ "key": "useSsl", "type": "toggle", "labelKey": format!("{f}.use_ssl"), "default": false }),
        ];
        if let Some(u) = url_base {
            fields.push(json!({ "key": "urlBase", "type": "text", "labelKey": format!("{f}.url_base"), "default": u }));
        }
        fields.extend([
            json!({ "key": "username", "type": "text", "labelKey": format!("{f}.username") }),
            json!({ "key": "password", "type": "password", "labelKey": format!("{f}.password"), "secret": true }),
            json!({ "key": "category", "type": "text", "labelKey": format!("{f}.category"), "default": "fliks" }),
            json!({ "key": "movieCategory", "type": "text", "labelKey": format!("{f}.movie_category") }),
            json!({ "key": "seriesCategory", "type": "text", "labelKey": format!("{f}.series_category") }),
        ]);
        json!({
            "implementation": imp,
            "labelKey": format!("download.config.download_clients.implementations.{imp}"),
            "fields": fields,
        })
    };
    json!([
        def("qbittorrent", 8080, None),
        def("transmission", 9091, Some("/transmission/")),
    ])
});

fn indexer_implementations(_: &Request) -> R<Response> {
    ok(&*INDEXER_IMPLEMENTATIONS)
}
fn source_implementations(_: &Request) -> R<Response> {
    ok(&*SOURCE_IMPLEMENTATIONS)
}
fn client_implementations(_: &Request) -> R<Response> {
    ok(&*CLIENT_IMPLEMENTATIONS)
}

// --- table ---------------------------------------------------------------------------------

macro_rules! h {
    ($f:path) => {{
        fn wrapped(r: &Request) -> Result<Response, String> {
            Ok(respond($f(r)))
        }
        wrapped as Handler
    }};
}

/// Literal segments come before their `:id` siblings: the first match wins.
pub fn table() -> Vec<(&'static str, &'static str, Handler)> {
    vec![
        ("GET", "/:id/releases", h!(search_releases)),
        ("POST", "/:id/grab", h!(grab_release)),
        (
            "GET",
            "/:id/seasons/:seasonId/releases",
            h!(search_releases),
        ),
        ("POST", "/:id/seasons/:seasonId/grab", h!(grab_release)),
        (
            "GET",
            "/:id/episodes/:episodeId/releases",
            h!(search_releases),
        ),
        ("POST", "/:id/episodes/:episodeId/grab", h!(grab_release)),
        ("GET", "/queue", h!(queue)),
        ("GET", "/history", h!(history_page)),
        ("GET", "/indexers", h!(list_indexers)),
        ("POST", "/indexers", h!(create_indexer)),
        ("POST", "/indexers/test-connection", h!(test_indexer)),
        ("DELETE", "/indexers/cooldowns", h!(clear_cooldowns)),
        (
            "GET",
            "/indexers/implementations",
            h!(indexer_implementations),
        ),
        ("PUT", "/indexers/:id", h!(update_indexer)),
        ("DELETE", "/indexers/:id", h!(delete_indexer)),
        ("DELETE", "/indexers/:id/cooldown", h!(clear_cooldown)),
        ("GET", "/indexers/:id/stats", h!(indexer_stats)),
        ("GET", "/indexer-sources", h!(list_sources)),
        ("POST", "/indexer-sources", h!(create_source)),
        ("POST", "/indexer-sources/test-connection", h!(test_source)),
        (
            "GET",
            "/indexer-sources/implementations",
            h!(source_implementations),
        ),
        ("PUT", "/indexer-sources/:id", h!(update_source)),
        ("DELETE", "/indexer-sources/:id", h!(delete_source)),
        ("POST", "/indexer-sources/:id/import", h!(import_source)),
        ("GET", "/download-clients", h!(list_clients)),
        ("POST", "/download-clients", h!(create_client)),
        ("POST", "/download-clients/test-connection", h!(test_client)),
        (
            "GET",
            "/download-clients/implementations",
            h!(client_implementations),
        ),
        ("PUT", "/download-clients/:id", h!(update_client)),
        ("DELETE", "/download-clients/:id", h!(delete_client)),
        ("POST", "/queue/:id/pause", h!(pause)),
        ("POST", "/queue/:id/resume", h!(resume)),
        ("DELETE", "/queue/:id", h!(remove_queued)),
        ("POST", "/queue/:id/retry-import", h!(retry_import)),
        ("DELETE", "/history/all", h!(clear_history)),
        ("DELETE", "/history/:id", h!(delete_history)),
        ("GET", "/blocklist", h!(list_blocklist)),
        ("DELETE", "/blocklist/all", h!(clear_blocklist)),
        ("DELETE", "/blocklist/:id", h!(remove_blocklist)),
    ]
}

pub static ROUTER: LazyLock<Router> = LazyLock::new(|| {
    table()
        .into_iter()
        .fold(Router::new(), |r, (m, p, h)| r.route(m, p, h))
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_parsing() {
        assert_eq!(page_number(None, 1), 1);
        assert_eq!(page_number(Some("2.7"), 1), 2);
        assert_eq!(page_number(Some("-3"), 1), 1);
        assert_eq!(page_number(Some(""), 1), 1);
        assert_eq!(page_size(Some("500")), 100);
        assert_eq!(page_size(Some("0")), 25);
        assert_eq!(page_size(None), 25);
    }

    #[test]
    fn info_urls() {
        assert_eq!(
            info_url(Some(&json!("https://t/x"))),
            Some("https://t/x".into())
        );
        assert_eq!(info_url(Some(&json!("javascript:alert(1)"))), None);
        assert_eq!(info_url(Some(&json!("/rel"))), None);
    }

    #[test]
    fn use_for_gates() {
        let b = |v: Value| v.as_object().unwrap().clone();
        assert!(matches!(gates(&b(json!({ "useFor": [] }))), Gates::Empty));
        assert!(matches!(
            gates(&b(json!({ "useFor": ["bogus"] }))),
            Gates::Invalid
        ));
        assert!(matches!(
            gates(&b(json!({ "useFor": null }))),
            Gates::Invalid
        ));
        assert!(matches!(
            gates(&b(json!({ "useFor": ["auto"], "enableRss": true }))),
            Gates::Ok(Some(false), Some(true), Some(false))
        ));
        assert!(matches!(
            gates(&b(json!({ "enableRss": false }))),
            Gates::Ok(Some(false), None, None)
        ));
    }
}

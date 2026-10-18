//! qBittorrent Web API v2, the torrent-hash helpers, and download-client CRUD.

use crate::db::{DownloadClientRow, clients};
use crate::error::{Error, R};
use crate::net::{self, Body, Resp};
use crate::util::{
    Settings, decode_html_entities, js_string, merge_secrets, redact_secrets, setting, truthy,
};
use fliks_plugin_sdk::bindings::wasi::http::types::Method;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

const SECRET_KEYS: [&str; 1] = ["password"];
pub const IMPLEMENTATIONS: [&str; 1] = ["qbittorrent"];

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Torrent {
    pub hash: String,
    pub name: String,
    pub size: i64,
    pub downloaded: i64,
    pub progress: f64,
    pub dlspeed: f64,
    pub ratio: f64,
    pub completion_on: Option<f64>,
    pub eta: f64,
    pub state: String,
    pub save_path: Option<String>,
    pub added_on: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct TorrentFile {
    pub name: String,
    pub progress: f64,
}

static MAGNET_HEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"xt=urn:btih:([a-fA-F0-9]{40})").unwrap());
static MAGNET_B32: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)xt=urn:btih:([A-Z2-7]{32})").unwrap());

/// 40 hex chars or 32 base32 chars.
pub fn magnet_hash(magnet: &str) -> Option<String> {
    if let Some(c) = MAGNET_HEX.captures(magnet) {
        return Some(c[1].to_lowercase());
    }
    let b32 = MAGNET_B32.captures(magnet)?[1].to_uppercase();
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let (mut bits, mut value, mut out) = (0u32, 0u32, Vec::with_capacity(20));
    for ch in b32.bytes() {
        let v = ALPHABET.iter().position(|a| *a == ch)? as u32;
        value = (value << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((value >> bits) & 0xff) as u8);
        }
    }
    Some(hex(&out))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The byte just past the bencoded value at `pos`; nesting is capped so a hostile file cannot
/// exhaust the stack.
fn bencoded_end(buf: &[u8], pos: usize, depth: u32) -> Option<usize> {
    if depth > 256 {
        return None;
    }
    match *buf.get(pos)? {
        b'i' => buf[pos + 1..]
            .iter()
            .position(|b| *b == b'e')
            .map(|e| pos + 1 + e + 1),
        b'l' | b'd' => {
            let mut cur = pos + 1;
            while cur < buf.len() && buf[cur] != b'e' {
                cur = bencoded_end(buf, cur, depth + 1)?;
            }
            (cur < buf.len()).then_some(cur + 1)
        }
        b'0'..=b'9' => {
            let colon = pos + buf[pos..].iter().position(|b| *b == b':')?;
            let len: usize = std::str::from_utf8(&buf[pos..colon]).ok()?.parse().ok()?;
            colon.checked_add(1)?.checked_add(len)
        }
        _ => None,
    }
}

/// SHA-1 of the raw bencoded `info` dict: the BitTorrent info-hash.
pub fn info_hash(buf: &[u8]) -> Option<String> {
    let marker = b"4:info";
    let idx = buf.windows(marker.len()).position(|w| w == marker)?;
    let start = idx + marker.len();
    if buf.get(start) != Some(&b'd') {
        return None;
    }
    let end = bencoded_end(buf, start, 0)?.min(buf.len());
    Some(hex(&Sha1::digest(&buf[start..end])))
}

static PORT_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r":([0-9]+)$").unwrap());
static SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://").unwrap());

/// Host, port and scheme from whatever shape the admin typed.
pub fn base_url(s: &Settings) -> Option<String> {
    let raw = if truthy(s.get("host")) {
        js_string(&s["host"])
    } else {
        String::new()
    };
    let host = raw.strip_suffix('/').unwrap_or(&raw);
    if host.is_empty() {
        return None;
    }
    let protocol = if truthy(s.get("useSsl")) {
        "https"
    } else {
        "http"
    };
    let mut host = SCHEME.replace(host, "").into_owned();
    let from_host = PORT_SUFFIX.captures(&host).map(|c| c[1].to_owned());
    if from_host.is_some() {
        host = PORT_SUFFIX.replace(&host, "").into_owned();
    }
    let port = if truthy(s.get("port")) {
        Some(js_string(&s["port"]))
    } else {
        from_host
            .and_then(|p| p.parse::<u64>().ok())
            .map(|p| p.to_string())
    };
    Some(match port {
        Some(p) => format!("{protocol}://{host}:{p}"),
        None => format!("{protocol}://{host}"),
    })
}

pub fn supports(c: &DownloadClientRow) -> bool {
    c.enabled && c.implementation.to_lowercase().contains("qbittorrent")
}

const T15: Duration = Duration::from_secs(15);
const T60: Duration = Duration::from_secs(60);

fn client_err(e: String) -> Error {
    Error::Client(format!(
        "could not reach the download client: {}",
        e.trim_start_matches("fetch failed: ")
    ))
}

/// The `Cookie` header for later calls.
fn login(base: &str, s: &Settings, timeout: Duration) -> R<String> {
    let form = vec![
        ("username".to_owned(), setting(s, "username")),
        ("password".to_owned(), setting(s, "password")),
    ];
    let res = net::send(
        Method::Post,
        &format!("{base}/api/v2/auth/login"),
        &[],
        Body::Form(form),
        timeout,
    )
    .map_err(client_err)?;
    let cookies = res.all("set-cookie");
    if cookies.is_empty() || res.text() == "Fails." {
        return Err(Error::Client(
            "download client authentication failed".into(),
        ));
    }
    Ok(cookies
        .iter()
        .map(|c| c.split(';').next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("; "))
}

/// One entry that does not parse makes the whole list unusable: the client counts as unreachable.
fn json_array<T: for<'de> Deserialize<'de>>(r: &Resp) -> Option<Vec<T>> {
    if r.status != 200 {
        return None;
    }
    serde_json::from_slice(&r.body).ok()
}

fn info_url(base: &str, category: &str) -> String {
    if category.is_empty() {
        format!("{base}/api/v2/torrents/info")
    } else {
        format!(
            "{base}/api/v2/torrents/info?category={}",
            crate::util::encode_uri_component(category)
        )
    }
}

fn snapshot(base: &str, cookie: &str, category: &str) -> HashSet<String> {
    net::get(&info_url(base, category), &[("cookie", cookie)], T60)
        .ok()
        .and_then(|r| json_array::<Torrent>(&r))
        .map(|ts| {
            ts.into_iter()
                .filter(|t| !t.hash.is_empty())
                .map(|t| t.hash.to_lowercase())
                .collect()
        })
        .unwrap_or_default()
}

/// The torrent that appeared since `before`, polled for about 3 s.
fn recover_new_hash(base: &str, cookie: &str, before: &HashSet<String>) -> Option<String> {
    for _ in 0..6 {
        std::thread::sleep(Duration::from_millis(500));
        let Some(after) = net::get(&info_url(base, ""), &[("cookie", cookie)], T60)
            .ok()
            .and_then(|r| json_array::<Torrent>(&r))
        else {
            continue;
        };
        let mut fresh: Vec<Torrent> = after
            .into_iter()
            .filter(|t| !t.hash.is_empty() && !before.contains(&t.hash.to_lowercase()))
            .collect();
        if !fresh.is_empty() {
            fresh.sort_by_key(|t| std::cmp::Reverse(t.added_on));
            return Some(fresh[0].hash.to_lowercase());
        }
    }
    None
}

enum Fetched {
    File(Vec<u8>),
    Magnet(String),
}

/// Walks the indexer's redirects by hand so a `magnet:` Location is caught before it is dialled.
fn fetch_torrent(start: &str) -> R<Fetched> {
    let mut url = start.to_owned();
    for _ in 0..=5 {
        let res = net::get(&url, &[], Duration::from_secs(30)).map_err(|e| {
            Error::Unobtainable(format!(
                "could not fetch the torrent from the indexer: {}",
                e.trim_start_matches("fetch failed: ")
            ))
        })?;
        if res.is_redirect() {
            let Some(loc) = res.header("location") else {
                return Err(Error::Unobtainable(format!(
                    "the indexer redirected without a Location header (HTTP {})",
                    res.status
                )));
            };
            if loc.starts_with("magnet:") {
                return Ok(Fetched::Magnet(loc));
            }
            url = net::resolve(&url, &loc).ok_or_else(|| {
                Error::Unobtainable(
                    "could not fetch the torrent from the indexer: Invalid URL".into(),
                )
            })?;
            continue;
        }
        if res.status != 200 {
            return Err(Error::Unobtainable(format!(
                "the indexer returned HTTP {} for this release's download",
                res.status
            )));
        }
        return Ok(Fetched::File(res.body));
    }
    Err(Error::Unobtainable(
        "the indexer's redirect chain exceeded 5 hops".into(),
    ))
}

fn add_magnet(base: &str, cookie: &str, magnet: &str, category: &str) -> R<Resp> {
    let mut form = vec![("urls".to_owned(), magnet.to_owned())];
    if !category.is_empty() {
        form.push(("category".into(), category.into()));
    }
    net::send(
        Method::Post,
        &format!("{base}/api/v2/torrents/add"),
        &[("cookie", cookie)],
        Body::Form(form),
        T60,
    )
    .map_err(client_err)
}

fn add_file(base: &str, cookie: &str, file: &[u8], category: &str) -> R<Resp> {
    let fields: Vec<(&str, &str)> = if category.is_empty() {
        vec![]
    } else {
        vec![("category", category)]
    };
    let body = net::multipart(
        "torrents",
        "download.torrent",
        "application/x-bittorrent",
        file,
        &fields,
    );
    net::send(
        Method::Post,
        &format!("{base}/api/v2/torrents/add"),
        &[("cookie", cookie)],
        body,
        T60,
    )
    .map_err(client_err)
}

fn no_host() -> Error {
    Error::Client("download client has no host configured".into())
}

/// `ok: false` when the client could not be asked: never read that as "holds nothing".
pub fn torrents(c: &DownloadClientRow) -> (bool, Vec<Torrent>) {
    let Some(base) = base_url(&c.settings) else {
        return (false, vec![]);
    };
    let cookie = match login(&base, &c.settings, T15) {
        Ok(k) => k,
        Err(e) => {
            warn!(
                "getTorrentsResult: auth failed for client \"{}\": {e}",
                c.name
            );
            return (false, vec![]);
        }
    };
    let category = setting(&c.settings, "category").trim().to_owned();
    match net::get(&info_url(&base, &category), &[("cookie", &cookie)], T15) {
        Ok(r) => match json_array::<Torrent>(&r) {
            Some(ts) => (
                true,
                ts.into_iter()
                    .map(|t| Torrent {
                        name: decode_html_entities(&t.name),
                        ..t
                    })
                    .collect(),
            ),
            None => {
                warn!(
                    "getTorrentsResult: unexpected response from \"{}\" (HTTP {})",
                    c.name, r.status
                );
                (false, vec![])
            }
        },
        Err(e) => {
            warn!(
                "getTorrentsResult: error fetching torrents from \"{}\": {e}",
                c.name
            );
            (false, vec![])
        }
    }
}

pub fn files(c: &DownloadClientRow, hash: &str) -> Option<Vec<TorrentFile>> {
    let base = base_url(&c.settings)?;
    let cookie = login(&base, &c.settings, T15)
        .inspect_err(|e| {
            warn!(
                "getTorrentFilesResult: auth failed for client \"{}\": {e}",
                c.name
            )
        })
        .ok()?;
    let url = format!(
        "{base}/api/v2/torrents/files?hash={}",
        crate::util::encode_uri_component(hash)
    );
    match net::get(&url, &[("cookie", &cookie)], T15) {
        Ok(r) => json_array(&r).or_else(|| {
            warn!(
                "getTorrentFilesResult: unexpected response for hash {hash} (HTTP {})",
                r.status
            );
            None
        }),
        Err(e) => {
            warn!("getTorrentFilesResult: error for hash {hash}: {e}");
            None
        }
    }
}

/// qBittorrent 5 spells these `stop`/`start`, 4.x `pause`/`resume`: the old name on a 404.
fn command(c: &DownloadClientRow, hash: &str, action: &str, legacy: &str) -> R<()> {
    let base = base_url(&c.settings).ok_or_else(no_host)?;
    let cookie = login(&base, &c.settings, T15)?;
    let post = |name: &str| {
        net::send(
            Method::Post,
            &format!("{base}/api/v2/torrents/{name}"),
            &[("cookie", &cookie)],
            Body::Form(vec![("hashes".into(), hash.into())]),
            T15,
        )
        .map_err(client_err)
    };
    let mut res = post(action)?;
    if res.status == 404 {
        res = post(legacy)?;
    }
    if res.status != 200 {
        return Err(Error::Client(format!(
            "the download client refused {action} (HTTP {})",
            res.status
        )));
    }
    Ok(())
}

pub fn pause(c: &DownloadClientRow, hash: &str) -> R<()> {
    command(c, hash, "stop", "pause")
}

pub fn resume(c: &DownloadClientRow, hash: &str) -> R<()> {
    command(c, hash, "start", "resume")
}

pub fn delete(c: &DownloadClientRow, hash: &str, delete_files: bool) -> R<()> {
    let base = base_url(&c.settings).ok_or_else(no_host)?;
    let cookie = login(&base, &c.settings, T15)?;
    let form = vec![
        ("hashes".to_owned(), hash.to_owned()),
        ("deleteFiles".to_owned(), delete_files.to_string()),
    ];
    let res = net::send(
        Method::Post,
        &format!("{base}/api/v2/torrents/delete"),
        &[("cookie", &cookie)],
        Body::Form(form),
        T15,
    )
    .map_err(client_err)?;
    if res.status != 200 {
        return Err(Error::Client(format!(
            "the download client refused the deletion (HTTP {})",
            res.status
        )));
    }
    Ok(())
}

/// Adds the release and answers its hash; a held hash is the release already (optionally refused).
pub fn add(
    c: &DownloadClientRow,
    torrent_url: &str,
    media_type: &str,
    reject_if_present: bool,
) -> R<String> {
    let url = torrent_url.replace("&amp;", "&");
    let base = base_url(&c.settings).ok_or_else(no_host)?;
    let s = &c.settings;
    let mut category = setting(s, "category").trim().to_owned();
    if media_type == "movie" && truthy(s.get("movieCategory")) {
        category = setting(s, "movieCategory").trim().to_owned();
    }
    if media_type == "series" && truthy(s.get("seriesCategory")) {
        category = setting(s, "seriesCategory").trim().to_owned();
    }
    let cookie = login(&base, s, T60)?;
    let before = snapshot(&base, &cookie, &category);
    let held = |hash: &Option<String>| -> R<Option<String>> {
        match hash {
            Some(h) if before.contains(&h.to_lowercase()) => {
                if reject_if_present {
                    Err(Error::Other(format!(
                        "torrent {h} is already in the download client"
                    )))
                } else {
                    Ok(Some(h.clone()))
                }
            }
            _ => Ok(None),
        }
    };
    let (mut hash, res) = if url.starts_with("magnet:") {
        let h = magnet_hash(&url);
        if let Some(h) = held(&h)? {
            return Ok(h);
        }
        (h, add_magnet(&base, &cookie, &url, &category)?)
    } else {
        match fetch_torrent(&url)? {
            Fetched::Magnet(m) => {
                let h = magnet_hash(&m);
                if let Some(h) = held(&h)? {
                    return Ok(h);
                }
                (h, add_magnet(&base, &cookie, &m, &category)?)
            }
            Fetched::File(b) => {
                let h = info_hash(&b);
                if let Some(h) = held(&h)? {
                    return Ok(h);
                }
                (h, add_file(&base, &cookie, &b, &category)?)
            }
        }
    };
    // 409: held outside the managed category; Fliks does not take over someone else's torrent.
    if res.status == 409 {
        return Err(Error::Unobtainable(
            "the download client already holds this torrent, outside the category Fliks manages"
                .into(),
        ));
    }
    if res.status != 200 {
        return Err(Error::Client(format!(
            "the download client refused the torrent (HTTP {})",
            res.status
        )));
    }
    if hash.is_none() {
        hash = recover_new_hash(&base, &cookie, &before);
    }
    let hash = hash.ok_or_else(|| {
        Error::Other("could not determine the hash of the torrent that was just added".into())
    })?;
    if reject_if_present && before.contains(&hash.to_lowercase()) {
        return Err(Error::Other(format!(
            "torrent {hash} is already in the download client"
        )));
    }
    Ok(hash)
}

pub fn test_connection(settings: &Settings) -> Value {
    let Some(base) = base_url(settings) else {
        return json!({ "ok": false, "messageKey": "download.download_clients.test.host_missing" });
    };
    match login(&base, settings, Duration::from_secs(10)) {
        Ok(_) => json!({ "ok": true, "messageKey": "download.download_clients.test.ok" }),
        Err(Error::Client(m)) if m == "download client authentication failed" => {
            json!({ "ok": false, "messageKey": "download.download_clients.test.auth_failed" })
        }
        Err(e) => {
            json!({ "ok": false, "messageKey": "download.download_clients.test.network_error", "detail": e.to_string() })
        }
    }
}

/// Core's closed progress vocabulary from qBittorrent's states.
pub fn progress_state(state: &str) -> &'static str {
    match state {
        "queuedDL" => "queued",
        "stalledDL" | "error" | "missingFiles" => "stalled",
        "pausedDL" | "pausedUP" | "stoppedDL" | "stoppedUP" => "paused",
        "moving" => "importing",
        _ => "active",
    }
}

/// States where progress is expected, so a flat counter means a stall.
pub const STALL_ELIGIBLE: [&str; 7] = [
    "downloading",
    "forcedDL",
    "stalledDL",
    "metaDL",
    "forcedMetaDL",
    "error",
    "missingFiles",
];

/// Trailing run of no-progress steps, samples newest first; a lone sample is one strike.
pub fn stalled_strikes(samples: &[(i64, i64)], min_bytes_per_second: f64) -> i64 {
    if samples.is_empty() {
        return 0;
    }
    let mut strikes = 1;
    for w in samples.windows(2) {
        let ((newer_b, newer_t), (older_b, older_t)) = (w[0], w[1]);
        let delta = newer_b - older_b;
        // A counter reset (a recheck) restarts the run rather than counting as flat.
        if delta < 0 || delta as f64 >= min_bytes_per_second * ((newer_t - older_t) as f64 / 1000.0)
        {
            break;
        }
        strikes += 1;
    }
    strikes
}

// --- download-client rows -------------------------------------------------------------------

pub fn redact(c: &DownloadClientRow) -> DownloadClientRow {
    DownloadClientRow {
        settings: redact_secrets(Some(&c.settings), &SECRET_KEYS),
        ..c.clone()
    }
}

fn check_implementation(i: &str) -> R<()> {
    if IMPLEMENTATIONS.contains(&i) {
        Ok(())
    } else {
        Err(Error::UnknownImplementation(format!(
            "Unknown download client implementation \"{i}\""
        )))
    }
}

pub fn find(id: i64) -> R<DownloadClientRow> {
    clients::find(id)?.ok_or_else(|| Error::NotFound(format!("Download client #{id} not found")))
}

/// A client this plugin can drive, or why not.
pub fn drivable(id: i64) -> R<DownloadClientRow> {
    let c = find(id)?;
    if !IMPLEMENTATIONS.contains(&c.implementation.as_str()) || !supports(&c) {
        return Err(Error::UnknownImplementation(format!(
            "Download client #{id} does not support this operation"
        )));
    }
    Ok(c)
}

pub struct Input {
    pub name: Option<String>,
    pub implementation: Option<String>,
    pub settings: Option<Settings>,
    pub enabled: Option<bool>,
    pub priority: Option<f64>,
}

pub fn create(i: Input) -> R<DownloadClientRow> {
    let implementation = i.implementation.unwrap_or_default();
    check_implementation(&implementation)?;
    let saved = clients::insert(&clients::Fields {
        name: i.name.unwrap_or_default(),
        implementation,
        settings: merge_secrets(None, &i.settings.unwrap_or_default(), &SECRET_KEYS),
        enabled: i.enabled.unwrap_or(true),
        priority: i.priority.unwrap_or(1.0),
    })?;
    Ok(redact(&saved))
}

pub fn update(id: i64, i: Input) -> R<DownloadClientRow> {
    let e = find(id)?;
    if let Some(imp) = &i.implementation {
        check_implementation(imp)?;
    }
    let saved = clients::update(
        id,
        &clients::Fields {
            name: i.name.unwrap_or(e.name),
            implementation: i.implementation.unwrap_or(e.implementation),
            settings: match &i.settings {
                Some(s) => merge_secrets(Some(&e.settings), s, &SECRET_KEYS),
                None => e.settings.clone(),
            },
            enabled: i.enabled.unwrap_or(e.enabled),
            priority: i.priority.unwrap_or(e.priority as f64),
        },
    )?;
    Ok(redact(&saved))
}

pub fn remove(id: i64) -> R<()> {
    find(id)?;
    clients::remove(id)
}

/// A blank password on a saved row tests the stored one; `null` tests without one.
pub fn test(implementation: &str, settings: &Settings, id: Option<i64>) -> Value {
    if !IMPLEMENTATIONS.contains(&implementation) {
        return json!({ "ok": false, "messageKey": "download.download_clients.test.unsupported_implementation", "detail": implementation });
    }
    let mut s = settings.clone();
    if s.get("password") == Some(&Value::Null) {
        s.shift_remove("password");
    } else if !truthy(s.get("password"))
        && let Some(stored) = id
            .and_then(|id| find(id).ok())
            .and_then(|c| c.settings.get("password").cloned())
            .filter(|p| truthy(Some(p)))
    {
        s.insert("password".into(), stored);
    }
    test_connection(&s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resp(status: u16, body: &str) -> Resp {
        Resp {
            status,
            headers: vec![],
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn a_list_with_one_bad_entry_is_incomplete() {
        let list = |s| json_array::<Torrent>(&resp(200, s)).map(|v| v.len());
        assert_eq!(list(r#"[{"hash":"a"},{"hash":"b"}]"#), Some(2));
        assert_eq!(list(r#"[{"hash":"a"},{"hash":7}]"#), None);
        assert_eq!(list(r#"[{"hash":"a"},"x"]"#), None);
        assert_eq!(list(r#"{"hash":"a"}"#), None);
        assert_eq!(
            json_array::<Torrent>(&resp(403, "[]")).map(|v| v.len()),
            None
        );
    }

    #[test]
    fn deep_bencode_is_refused() {
        let mut b = b"d4:info".to_vec();
        b.extend(std::iter::repeat_n(b'l', 10_000));
        assert_eq!(super::info_hash(&b), None);
    }
}

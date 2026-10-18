//! Indexer sources (Prowlarr, Jackett): saved connections whose configured indexers import as
//! ordinary torznab rows.

use crate::db::{IndexerRow, IndexerSourceRow, indexer_sources, indexers};
use crate::error::{Error, R};
use crate::net;
use crate::util::{
    Settings, encode_uri_component, js_string, merge_secrets, redact_secrets, setting,
};
use serde_json::{Value, json};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_HOPS: usize = 4;
const SECRET_KEYS: [&str; 1] = ["apiKey"];

const BASE_URL_MISSING: &str = "download.indexer_sources.test.base_url_missing";
const HTTP_ERROR: &str = "download.indexer_sources.test.http_error";
const UNEXPECTED: &str = "download.indexer_sources.test.unexpected_response";
const NETWORK_ERROR: &str = "download.indexer_sources.test.network_error";
const LOGIN_REQUIRED: &str = "download.indexer_sources.test.login_required";
const DISABLED: &str = "download.indexer_sources.errors.disabled";

pub const IMPLEMENTATIONS: [&str; 2] = ["prowlarr", "jackett"];

fn refused(message: impl Into<String>, key: &'static str, detail: Option<String>) -> Error {
    Error::Source {
        key,
        detail,
        message: message.into(),
    }
}

fn normalize_base(b: &str) -> String {
    b.trim().trim_end_matches('/').to_owned()
}

pub struct Remote {
    pub name: String,
    pub base_url: String,
    pub enabled: bool,
}

/// Follows redirects by hand, keeping every `Set-Cookie` (Jackett's admin API wants a session).
fn walk_with_jar(url: &str) -> Result<(net::Resp, String), String> {
    let mut cookies: Vec<(String, String)> = vec![];
    let jar = |c: &[(String, String)]| {
        c.iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ")
    };
    let mut target = url.to_owned();
    let mut hop = 0;
    loop {
        let cookie = jar(&cookies);
        let headers: Vec<(&str, &str)> = if cookies.is_empty() {
            vec![]
        } else {
            vec![("cookie", cookie.as_str())]
        };
        let res = net::get(&target, &headers, TIMEOUT)?;
        for raw in res.all("set-cookie") {
            let pair = raw.split(';').next().unwrap_or("");
            if let Some(eq) = pair.find('=').filter(|e| *e > 0) {
                let (k, v) = (pair[..eq].to_owned(), pair[eq + 1..].to_owned());
                match cookies.iter_mut().find(|(n, _)| *n == k) {
                    Some(c) => c.1 = v,
                    None => cookies.push((k, v)),
                }
            }
        }
        let location = if res.is_redirect() {
            res.header("location")
        } else {
            None
        };
        match location {
            Some(loc) if hop < MAX_HOPS => {
                target = net::resolve(&target, &loc).ok_or_else(|| "Invalid URL".to_owned())?;
                hop += 1;
            }
            _ => return Ok((res, jar(&cookies))),
        }
    }
}

fn fetch_list(url: &str, what: &str, headers: &[(&str, &str)], session: bool) -> R<Vec<Value>> {
    let res = if session {
        let (walked, jar) = walk_with_jar(url)
            .map_err(|e| refused(format!("{what} unreachable"), NETWORK_ERROR, Some(e)))?;
        let mut res = walked;
        if !(res.status == 200 && res.text().trim_start().starts_with('[')) && !jar.is_empty() {
            let mut h = headers.to_vec();
            h.push(("cookie", &jar));
            res = net::get(url, &h, TIMEOUT)
                .map_err(|e| refused(format!("{what} unreachable"), NETWORK_ERROR, Some(e)))?;
        }
        if res.is_redirect() {
            return Err(refused(
                format!("{what} still refuses the session"),
                LOGIN_REQUIRED,
                None,
            ));
        }
        res
    } else {
        net::get(url, headers, TIMEOUT)
            .map_err(|e| refused(format!("{what} unreachable"), NETWORK_ERROR, Some(e)))?
    };
    if res.status >= 300 {
        return Err(refused(
            format!("{what} answered HTTP {}", res.status),
            HTTP_ERROR,
            Some(res.status.to_string()),
        ));
    }
    match serde_json::from_slice::<Value>(&res.body) {
        Ok(Value::Array(a)) => Ok(a),
        Ok(other) => {
            let kind = match other {
                Value::Object(_) | Value::Null => "object",
                Value::String(_) => "string",
                Value::Number(_) => "number",
                Value::Bool(_) => "boolean",
                Value::Array(_) => "object",
            };
            Err(refused(
                format!("{what} answered {kind}, not a list"),
                UNEXPECTED,
                None,
            ))
        }
        Err(_) => Err(refused(
            format!("{what} answered a non-JSON body"),
            UNEXPECTED,
            None,
        )),
    }
}

fn id_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(n @ Value::Number(_)) => js_string(n),
        _ => String::new(),
    }
}

fn name_of(v: Option<&Value>) -> String {
    v.and_then(Value::as_str)
        .map_or(String::new(), |s| s.trim().to_owned())
}

/// The source's indexers; an unreadable source is an error, never an empty list.
pub fn fetch(implementation: &str, base_url: &str, api_key: &str) -> R<(Vec<Remote>, i64)> {
    let base = normalize_base(base_url);
    if base.is_empty() {
        return Err(refused(
            format!("{implementation} has no base URL"),
            BASE_URL_MISSING,
            None,
        ));
    }
    let key = encode_uri_component(api_key);
    let mut out = vec![];
    let mut unsupported = 0;
    if implementation == "prowlarr" {
        let url = format!("{base}/api/v1/indexer?apikey={key}");
        for row in fetch_list(&url, "prowlarr", &[("x-api-key", api_key)], false)? {
            let (id, name) = (id_of(row.get("id")), name_of(row.get("name")));
            if id.is_empty() || name.is_empty() {
                continue;
            }
            if row.get("protocol").is_some_and(|p| p != "torrent") {
                unsupported += 1;
                continue;
            }
            out.push(Remote {
                base_url: format!("{base}/{}/api", encode_uri_component(&id)),
                name,
                enabled: row.get("enable") != Some(&Value::Bool(false)),
            });
        }
    } else {
        let url = format!("{base}/api/v2.0/indexers?configured=true&apikey={key}");
        for row in fetch_list(&url, "jackett", &[], true)? {
            let (id, name) = (id_of(row.get("id")), name_of(row.get("name")));
            if id.is_empty()
                || name.is_empty()
                || row.get("configured") == Some(&Value::Bool(false))
            {
                continue;
            }
            out.push(Remote {
                base_url: format!(
                    "{base}/api/v2.0/indexers/{}/results/torznab/",
                    encode_uri_component(&id)
                ),
                name,
                enabled: true,
            });
        }
    }
    Ok((out, unsupported))
}

fn check_implementation(implementation: &str) -> R<()> {
    if IMPLEMENTATIONS.contains(&implementation) {
        Ok(())
    } else {
        Err(Error::UnknownImplementation(format!(
            "Unknown indexer source \"{implementation}\""
        )))
    }
}

pub fn redact(s: &IndexerSourceRow) -> IndexerSourceRow {
    IndexerSourceRow {
        settings: redact_secrets(Some(&s.settings), &SECRET_KEYS),
        ..s.clone()
    }
}

pub fn find(id: i64) -> R<IndexerSourceRow> {
    indexer_sources::find(id)?
        .ok_or_else(|| Error::NotFound(format!("Indexer source #{id} not found")))
}

pub struct Input {
    pub name: Option<String>,
    pub implementation: Option<String>,
    pub settings: Option<Settings>,
    pub priority: Option<f64>,
    pub enabled: Option<bool>,
}

pub fn create(i: Input) -> R<IndexerSourceRow> {
    let implementation = i.implementation.unwrap_or_default();
    check_implementation(&implementation)?;
    let saved = indexer_sources::insert(&indexer_sources::Fields {
        name: i.name.unwrap_or_default(),
        implementation,
        settings: merge_secrets(None, &i.settings.unwrap_or_default(), &SECRET_KEYS),
        priority: i.priority.unwrap_or(1.0),
        enabled: i.enabled.unwrap_or(true),
    })?;
    info!(
        "indexer source \"{}\" ({}) saved",
        saved.name, saved.implementation
    );
    Ok(redact(&saved))
}

pub fn update(id: i64, i: Input) -> R<IndexerSourceRow> {
    let existing = find(id)?;
    if let Some(imp) = &i.implementation {
        check_implementation(imp)?;
    }
    let saved = indexer_sources::update(
        id,
        &indexer_sources::Fields {
            name: i.name.unwrap_or(existing.name),
            implementation: i.implementation.unwrap_or(existing.implementation),
            settings: match &i.settings {
                None => existing.settings.clone(),
                Some(s) => merge_secrets(Some(&existing.settings), s, &SECRET_KEYS),
            },
            priority: i.priority.unwrap_or(existing.priority as f64),
            enabled: i.enabled.unwrap_or(existing.enabled),
        },
    )?;
    Ok(redact(&saved))
}

pub fn remove(id: i64) -> R<()> {
    find(id)?;
    indexer_sources::remove(id)?;
    info!("indexer source #{id} removed; the indexers it imported were kept");
    Ok(())
}

/// A blank key on a saved row tests the stored one; a `null` tests without one.
pub fn test_connection(implementation: &str, settings: &Settings, id: Option<i64>) -> Value {
    if !IMPLEMENTATIONS.contains(&implementation) {
        return json!({
            "ok": false, "messageKey": "download.indexer_sources.test.unknown_implementation", "detail": implementation,
        });
    }
    let base = setting(settings, "baseUrl").trim().to_owned();
    let key = if settings.get("apiKey") == Some(&Value::Null) {
        String::new()
    } else {
        let submitted = setting(settings, "apiKey").trim().to_owned();
        match id.filter(|_| submitted.is_empty()) {
            Some(id) => find(id).map_or(submitted, |s| {
                setting(&s.settings, "apiKey").trim().to_owned()
            }),
            None => submitted,
        }
    };
    if normalize_base(&base).is_empty() {
        return json!({ "ok": false, "messageKey": BASE_URL_MISSING });
    }
    match fetch(implementation, &base, &key) {
        Ok(_) => json!({ "ok": true, "messageKey": "download.indexer_sources.test.ok" }),
        Err(Error::Source {
            key,
            detail,
            message,
        }) => {
            let detail = detail.unwrap_or(message);
            warn!("indexer source test failed ({implementation}): {key} {detail}");
            json!({ "ok": false, "messageKey": key, "detail": detail })
        }
        Err(e) => json!({ "ok": false, "messageKey": NETWORK_ERROR, "detail": e.to_string() }),
    }
}

/// Imports everything the source has configured, deduped on the torznab endpoint. An existing
/// row keeps the admin's tuning; only a rotated API key is written back.
pub fn import(id: i64) -> R<Value> {
    let source = find(id)?;
    if !source.enabled {
        return Err(Error::Source {
            key: DISABLED,
            detail: None,
            message: format!("Indexer source #{id} is disabled"),
        });
    }
    check_implementation(&source.implementation)?;
    let api_key = setting(&source.settings, "apiKey");
    let (list, unsupported) = fetch(
        &source.implementation,
        &setting(&source.settings, "baseUrl"),
        &api_key,
    )
    .inspect_err(|e| {
        let detail = match e {
            Error::Source {
                detail: Some(d), ..
            } => format!(": {d}"),
            _ => String::new(),
        };
        error!(
            "import from \"{}\" ({}) failed: {e}{detail}",
            source.name, source.implementation
        );
    })?;
    let (mut created, mut updated, mut unchanged) = (0, 0, 0);
    for remote in list {
        match indexers::find_by_base_url(&remote.base_url)? {
            None => {
                let mut settings = Settings::new();
                settings.insert("baseUrl".into(), json!(remote.base_url));
                settings.insert("apiKey".into(), json!(api_key));
                crate::indexers::create(crate::indexers::Input {
                    name: Some(remote.name),
                    implementation: Some("torznab".into()),
                    settings: Some(settings),
                    enabled: Some(remote.enabled),
                    ..Default::default()
                })?;
                created += 1;
            }
            Some(IndexerRow { id, settings, .. }) if setting(&settings, "apiKey") != api_key => {
                let mut s = settings;
                s.insert("apiKey".into(), json!(api_key));
                indexers::update_settings(id, &s)?;
                updated += 1;
            }
            Some(_) => unchanged += 1,
        }
    }
    info!(
        "import from \"{}\" ({}): {created} added, {updated} key-refreshed, {unchanged} unchanged, {unsupported} unsupported",
        source.name, source.implementation
    );
    Ok(
        json!({ "created": created, "updated": updated, "unchanged": unchanged, "unsupported": unsupported }),
    )
}

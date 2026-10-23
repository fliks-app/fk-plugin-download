//! Transmission RPC. Fliks's category is a Transmission label (Transmission 3.0 and later).

use crate::client::{self, Fetched, Torrent, TorrentFile, client_err, no_host};
use crate::db::DownloadClientRow;
use crate::error::{Error, R};
use crate::net::{self, Body};
use crate::util::{Settings, base64, setting};
use fliks_plugin_sdk::bindings::wasi::http::types::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

const T15: Duration = Duration::from_secs(15);
const T60: Duration = Duration::from_secs(60);
const SESSION_HEADER: &str = "x-transmission-session-id";

const FIELDS: [&str; 15] = [
    "hashString",
    "name",
    "sizeWhenDone",
    "downloadedEver",
    "percentDone",
    "rateDownload",
    "uploadRatio",
    "doneDate",
    "eta",
    "status",
    "error",
    "downloadDir",
    "addedDate",
    "labels",
    "peersSendingToUs",
];

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Item {
    hash_string: String,
    name: String,
    size_when_done: i64,
    downloaded_ever: i64,
    percent_done: f64,
    rate_download: f64,
    upload_ratio: f64,
    done_date: f64,
    eta: f64,
    status: i64,
    error: i64,
    download_dir: Option<String>,
    added_date: i64,
    labels: Vec<String>,
    peers_sending_to_us: i64,
    files: Vec<File>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct File {
    name: String,
    length: i64,
    bytes_completed: i64,
}

#[derive(Deserialize)]
struct Reply {
    result: String,
    #[serde(default)]
    arguments: Value,
}

/// Transmission's status as the qBittorrent state names `Torrent` carries.
fn state(t: &Item) -> &'static str {
    // 1 and 2 are tracker warnings and errors, which leave the transfer running.
    if t.error == 3 {
        return "error";
    }
    match t.status {
        0 if t.percent_done >= 1.0 => "stoppedUP",
        0 => "stoppedDL",
        1 | 2 => "checkingDL",
        3 => "queuedDL",
        4 if t.peers_sending_to_us == 0 => "stalledDL",
        4 => "downloading",
        5 => "queuedUP",
        6 => "uploading",
        _ => "unknown",
    }
}

fn torrent(t: Item) -> Torrent {
    Torrent {
        state: state(&t).into(),
        hash: t.hash_string,
        name: t.name,
        size: t.size_when_done,
        downloaded: t.downloaded_ever,
        progress: t.percent_done,
        dlspeed: t.rate_download,
        // -1 is "no ratio" and -2 "infinite": only reachable without downloading anything.
        ratio: t.upload_ratio.max(0.0),
        completion_on: (t.done_date > 0.0).then_some(t.done_date),
        eta: t.eta,
        save_path: t.download_dir,
        added_on: t.added_date,
    }
}

fn endpoint(s: &Settings) -> Option<String> {
    let base = client::base_url(s)?;
    let path = setting(s, "urlBase");
    let path = path.trim().trim_matches('/');
    let path = if path.is_empty() {
        "transmission"
    } else {
        path
    };
    Some(format!("{base}/{path}/rpc"))
}

/// One RPC call; a 409 hands out the session id the retry carries.
fn rpc(s: &Settings, method: &str, arguments: Value, timeout: Duration) -> R<Value> {
    let url = endpoint(s).ok_or_else(no_host)?;
    let (user, pass) = (setting(s, "username"), setting(s, "password"));
    let auth = (!user.is_empty() || !pass.is_empty())
        .then(|| format!("Basic {}", base64(format!("{user}:{pass}").as_bytes())));
    let body = serde_json::to_vec(&json!({ "method": method, "arguments": arguments }))
        .unwrap_or_default();
    let mut session = String::new();
    for _ in 0..2 {
        let mut headers = vec![(SESSION_HEADER, session.as_str())];
        if let Some(a) = &auth {
            headers.push(("authorization", a));
        }
        let res = net::send(
            Method::Post,
            &url,
            &headers,
            Body::Raw {
                content_type: "application/json".into(),
                bytes: body.clone(),
            },
            timeout,
        )
        .map_err(client_err)?;
        match res.status {
            409 => session = res.header(SESSION_HEADER).unwrap_or_default(),
            401 | 403 => return Err(client::auth_failed()),
            200 => {
                let reply: Reply = serde_json::from_slice(&res.body).map_err(|_| {
                    Error::Client("unexpected response from the download client".into())
                })?;
                if reply.result != "success" {
                    return Err(Error::Client(format!(
                        "the download client refused {method}: {}",
                        reply.result
                    )));
                }
                return Ok(reply.arguments);
            }
            s => {
                return Err(Error::Client(format!(
                    "the download client refused {method} (HTTP {s})"
                )));
            }
        }
    }
    Err(Error::Client(
        "the download client did not accept its own session id".into(),
    ))
}

fn get(s: &Settings, ids: Option<&str>, fields: &[&str], timeout: Duration) -> R<Vec<Item>> {
    let mut args = json!({ "fields": fields });
    if let Some(h) = ids {
        args["ids"] = json!([h]);
    }
    let mut reply = rpc(s, "torrent-get", args, timeout)?;
    serde_json::from_value(reply["torrents"].take())
        .map_err(|_| Error::Client("unexpected response from the download client".into()))
}

fn category(s: &Settings) -> String {
    setting(s, "category").trim().to_owned()
}

fn labelled(t: &Item, category: &str) -> bool {
    category.is_empty() || t.labels.iter().any(|l| l == category)
}

pub fn torrents(c: &DownloadClientRow) -> (bool, Vec<Torrent>) {
    match get(&c.settings, None, &FIELDS, T15) {
        Ok(items) => {
            let category = category(&c.settings);
            (
                true,
                items
                    .into_iter()
                    .filter(|t| labelled(t, &category))
                    .map(torrent)
                    .collect(),
            )
        }
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
    let items = get(&c.settings, Some(hash), &["files"], T15)
        .inspect_err(|e| warn!("getTorrentFilesResult: error for hash {hash}: {e}"))
        .ok()?;
    let t = items.into_iter().next()?;
    Some(
        t.files
            .into_iter()
            .map(|f| TorrentFile {
                progress: if f.length > 0 {
                    f.bytes_completed as f64 / f.length as f64
                } else {
                    1.0
                },
                name: f.name,
            })
            .collect(),
    )
}

pub fn pause(c: &DownloadClientRow, hash: &str) -> R<()> {
    rpc(&c.settings, "torrent-stop", json!({ "ids": [hash] }), T15).map(|_| ())
}

pub fn resume(c: &DownloadClientRow, hash: &str) -> R<()> {
    rpc(&c.settings, "torrent-start", json!({ "ids": [hash] }), T15).map(|_| ())
}

pub fn delete(c: &DownloadClientRow, hash: &str, delete_files: bool) -> R<()> {
    let args = json!({ "ids": [hash], "delete-local-data": delete_files });
    rpc(&c.settings, "torrent-remove", args, T15).map(|_| ())
}

pub fn add(c: &DownloadClientRow, url: &str, category: &str, reject_if_present: bool) -> R<String> {
    let s = &c.settings;
    let args = match client::fetch(url)? {
        Fetched::Magnet(m) => json!({ "filename": m }),
        Fetched::File(b) => json!({ "metainfo": base64(&b) }),
    };
    let reply = rpc(s, "torrent-add", args, T60)?;
    let hash_of = |key: &str| reply[key]["hashString"].as_str().map(|h| h.to_lowercase());
    if let Some(hash) = hash_of("torrent-duplicate") {
        let held = get(s, Some(&hash), &["labels"], T60)?
            .first()
            .is_some_and(|t| labelled(t, category));
        return match (held, reject_if_present) {
            (false, _) => Err(client::held_outside_category()),
            (true, true) => Err(client::already_held(&hash)),
            (true, false) => Ok(hash),
        };
    }
    let hash = hash_of("torrent-added").ok_or_else(|| {
        Error::Other("could not determine the hash of the torrent that was just added".into())
    })?;
    // `torrent-add` takes labels from 4.0 only; `torrent-set` from 3.0.
    if !category.is_empty() {
        let args = json!({ "ids": [hash], "labels": [category] });
        rpc(s, "torrent-set", args, T60)?;
    }
    Ok(hash)
}

pub fn check(settings: &Settings) -> R<()> {
    let args = json!({ "fields": ["rpc-version"] });
    rpc(settings, "session-get", args, Duration::from_secs(10)).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_status_to_the_torrent_states() {
        let st = |status, percent_done, peers, error| {
            state(&Item {
                status,
                percent_done,
                peers_sending_to_us: peers,
                error,
                ..Item::default()
            })
        };
        assert_eq!(st(0, 0.5, 0, 0), "stoppedDL");
        assert_eq!(st(0, 1.0, 0, 0), "stoppedUP");
        assert_eq!(st(4, 0.5, 0, 0), "stalledDL");
        assert_eq!(st(4, 0.5, 3, 2), "downloading");
        assert_eq!(st(4, 0.5, 3, 3), "error");
        assert_eq!(st(6, 1.0, 0, 0), "uploading");
    }

    #[test]
    fn rpc_path_defaults_to_transmission() {
        let s = |v: Value| serde_json::from_value::<Settings>(v).unwrap();
        assert_eq!(
            endpoint(&s(json!({ "host": "nas", "port": 9091 }))).as_deref(),
            Some("http://nas:9091/transmission/rpc")
        );
        assert_eq!(
            endpoint(&s(json!({ "host": "nas", "urlBase": "/tr/" }))).as_deref(),
            Some("http://nas/tr/rpc")
        );
    }
}

//! qBittorrent Web API v2.

use crate::client::{self, Fetched, Torrent, TorrentFile, client_err, no_host};
use crate::db::DownloadClientRow;
use crate::error::{Error, R};
use crate::net::{self, Body, Resp};
use crate::util::{Settings, decode_html_entities, setting};
use fliks_plugin_sdk::bindings::wasi::http::types::Method;
use serde::Deserialize;
use std::collections::HashSet;
use std::time::Duration;

const T15: Duration = Duration::from_secs(15);
const T60: Duration = Duration::from_secs(60);

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
        return Err(client::auth_failed());
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

pub fn torrents(c: &DownloadClientRow) -> (bool, Vec<Torrent>) {
    let Some(base) = client::base_url(&c.settings) else {
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
    let base = client::base_url(&c.settings)?;
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
    let base = client::base_url(&c.settings).ok_or_else(no_host)?;
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
    let base = client::base_url(&c.settings).ok_or_else(no_host)?;
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

pub fn add(c: &DownloadClientRow, url: &str, category: &str, reject_if_present: bool) -> R<String> {
    let base = client::base_url(&c.settings).ok_or_else(no_host)?;
    let cookie = login(&base, &c.settings, T60)?;
    let before = snapshot(&base, &cookie, category);
    let held = |hash: &Option<String>| -> R<Option<String>> {
        match hash {
            Some(h) if before.contains(&h.to_lowercase()) => {
                if reject_if_present {
                    Err(client::already_held(h))
                } else {
                    Ok(Some(h.clone()))
                }
            }
            _ => Ok(None),
        }
    };
    let (mut hash, res) = match client::fetch(url)? {
        Fetched::Magnet(m) => {
            let h = client::magnet_hash(&m);
            if let Some(h) = held(&h)? {
                return Ok(h);
            }
            (h, add_magnet(&base, &cookie, &m, category)?)
        }
        Fetched::File(b) => {
            let h = client::info_hash(&b);
            if let Some(h) = held(&h)? {
                return Ok(h);
            }
            (h, add_file(&base, &cookie, &b, category)?)
        }
    };
    // 409: held outside the managed category; Fliks does not take over someone else's torrent.
    if res.status == 409 {
        return Err(client::held_outside_category());
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
        return Err(client::already_held(&hash));
    }
    Ok(hash)
}

pub fn check(base: &str, settings: &Settings) -> R<()> {
    login(base, settings, Duration::from_secs(10)).map(|_| ())
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
}

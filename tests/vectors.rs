//! Golden vectors recorded from the TypeScript plugin at v0.12.1 (`tests/vectors/gen/gen.ts`),
//! and the manifest template against the published 0.12.1 manifest.

use fk_plugin_download::db::{IndexerRow, MIGRATIONS};
use fk_plugin_download::{grab, poller, qbit, routes, torznab, util};
use fliks_plugin_sdk::bindings::fliks::plugin::types::{ReleaseCoverage, Span};
use serde_json::{Value, json};

fn golden() -> Value {
    serde_json::from_str(include_str!("vectors/golden.json")).unwrap()
}

fn cases<'a>(g: &'a Value, k: &str) -> &'a Vec<Value> {
    g[k].as_array().unwrap_or_else(|| panic!("no {k} vectors"))
}

#[test]
fn migrations_are_byte_identical() {
    let g = golden();
    let recorded = cases(&g, "migrations");
    assert_eq!(recorded.len(), 8);
    for (i, m) in recorded.iter().enumerate() {
        assert_eq!(MIGRATIONS[i].0, m["name"].as_str().unwrap());
        assert_eq!(
            MIGRATIONS[i].1,
            m["up"].as_str().unwrap(),
            "{} differs",
            MIGRATIONS[i].0
        );
    }
    let names: Vec<&str> = MIGRATIONS[8..].iter().map(|m| m.0).collect();
    assert_eq!(
        names,
        [
            "0009_indexer_throttle",
            "0010_poller_state",
            "0011_download_history_import_lease"
        ]
    );
}

#[test]
fn html_entities() {
    for c in cases(&golden(), "htmlEntities") {
        assert_eq!(
            util::decode_html_entities(c["input"].as_str().unwrap()),
            c["output"].as_str().unwrap(),
            "{c}"
        );
    }
}

#[test]
fn encode_uri_component() {
    for c in cases(&golden(), "encodeUriComponent") {
        assert_eq!(
            util::encode_uri_component(c["input"].as_str().unwrap()),
            c["output"].as_str().unwrap()
        );
    }
}

#[test]
fn torznab_query() {
    for c in cases(&golden(), "torznabQuery") {
        let i = &c["input"];
        let s = |k: &str| i[k].as_str();
        let n = |k: &str| i[k].as_u64().map(|v| v as u32);
        let q = torznab::Query {
            t: s("t").unwrap(),
            q: s("q"),
            season: n("season"),
            ep: n("ep"),
            cat: s("cat").unwrap(),
            api_key: s("apiKey").unwrap(),
            tvdb_id: n("tvdbId"),
            imdb_id: s("imdbId"),
            tmdb_id: n("tmdbId"),
            supported_params: s("supportedParams"),
        };
        assert_eq!(
            torznab::build_query(&q),
            c["output"].as_str().unwrap(),
            "{c}"
        );
    }
    for c in cases(&golden(), "describeQuery") {
        assert_eq!(
            torznab::describe_query(c["input"].as_str().unwrap()),
            c["output"].as_str().unwrap()
        );
    }
}

#[test]
fn torznab_items() {
    for c in cases(&golden(), "torznabItems") {
        let ix: IndexerRow = serde_json::from_value(json!({
            "id": 7, "name": "test-indexer", "implementation": "torznab", "settings": c["settings"],
            "enableRss": true, "enableSearch": true, "enableInteractiveSearch": true, "priority": 25,
            "enabled": true, "capsSearchFallback": false, "capsMovieSearch": false, "capsTvSearch": false,
            "capsMovieSearchParams": null, "capsTvSearchParams": null, "capsProbedAt": null,
            "requestDelay": 2, "createdAt": "", "updatedAt": "",
        }))
        .unwrap();
        let got =
            serde_json::to_value(torznab::parse_items(c["xml"].as_str().unwrap(), &ix)).unwrap();
        assert_eq!(got, c["output"]);
    }
}

fn base64(s: &str) -> Vec<u8> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let (mut out, mut buf, mut bits) = (vec![], 0u32, 0);
    for c in s.bytes().filter(|c| *c != b'=') {
        buf = (buf << 6) | alphabet.iter().position(|a| *a == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}

#[test]
fn torrent_hashes() {
    let g = golden();
    for c in cases(&g, "magnetHash") {
        assert_eq!(
            qbit::magnet_hash(c["input"].as_str().unwrap()).as_deref(),
            c["output"].as_str()
        );
    }
    for c in cases(&g, "infoHash") {
        assert_eq!(
            qbit::info_hash(&base64(c["input"].as_str().unwrap())).as_deref(),
            c["output"].as_str()
        );
    }
}

#[test]
fn torrent_names() {
    for c in cases(&golden(), "torrentName") {
        assert_eq!(
            poller::normalise_name(c["input"].as_str().unwrap()),
            c["output"].as_str().unwrap()
        );
    }
}

#[test]
fn stall_strikes() {
    for c in cases(&golden(), "stallStrikes") {
        let samples: Vec<(i64, i64)> = c["input"]["samples"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                (
                    s["downloadedBytes"].as_i64().unwrap(),
                    util::parse_date_ms(s["checkedAt"].as_str().unwrap()).unwrap(),
                )
            })
            .collect();
        let min = c["input"]["minBytesPerSecond"].as_f64().unwrap();
        assert_eq!(
            qbit::stalled_strikes(&samples, min),
            c["output"].as_i64().unwrap(),
            "{c}"
        );
    }
}

#[test]
fn qbit_base_url() {
    for c in cases(&golden(), "qbitBaseUrl") {
        let s = c["input"].as_object().unwrap().clone();
        assert_eq!(qbit::base_url(&s).as_deref(), c["output"].as_str(), "{c}");
    }
}

#[test]
fn progress_state() {
    for c in cases(&golden(), "progressState") {
        assert_eq!(
            qbit::progress_state(c["input"].as_str().unwrap()),
            c["output"].as_str().unwrap()
        );
    }
}

#[test]
fn coverage_columns() {
    for c in cases(&golden(), "coverageColumns") {
        let span = |v: &Value| {
            v.as_object().map(|o| Span {
                first: o["from"].as_u64().unwrap() as u32,
                last: o["to"].as_u64().unwrap() as u32,
            })
        };
        let cov = c["input"].as_object().map(|o| ReleaseCoverage {
            seasons: span(&o["seasons"]),
            episodes: span(&o["episodes"]),
            complete_series: o["completeSeries"].as_bool().unwrap(),
        });
        let got = serde_json::to_value(grab::coverage_columns(cov.as_ref())).unwrap();
        assert_eq!(got, c["output"], "{c}");
    }
}

#[test]
fn secret_settings() {
    for c in cases(&golden(), "secretSettings") {
        let existing = c["input"]["existing"].as_object();
        let incoming = c["input"]["incoming"].as_object().unwrap();
        assert_eq!(
            Value::Object(util::merge_secrets(existing, incoming, &["apiKey"])),
            c["merged"],
            "{c}"
        );
        assert_eq!(
            Value::Object(util::redact_secrets(existing, &["apiKey"])),
            c["redacted"],
            "{c}"
        );
    }
}

/// Every key but the ones the port changes equals the published 0.12.1 manifest.
#[test]
fn template_matches_the_published_manifest() {
    let mut old: Value =
        serde_json::from_str(include_str!("vectors/manifest-0.12.1.json")).unwrap();
    let mut new: Value = serde_json::from_str(include_str!("../plugin.template.json")).unwrap();
    assert_eq!(
        (
            &new["pluginApi"],
            &new["fliks"],
            &new["runtime"],
            &new["network"]
        ),
        (
            &json!(2),
            &json!(">=5.0.0 <6.0.0"),
            &json!("wasm"),
            &json!({ "internal": true })
        )
    );
    let scopes: Vec<&str> = new["scopes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    assert!(!scopes.contains(&"requests:progress") && scopes.len() == 6);
    for k in [
        "pluginApi",
        "fliks",
        "runtime",
        "memoryMb",
        "scopes",
        "network",
        "version",
        "files",
    ] {
        old.as_object_mut().unwrap().remove(k);
        new.as_object_mut().unwrap().remove(k);
    }
    assert_eq!(new, old);
}

#[test]
fn routes_equal_the_manifest_both_ways() {
    let t: Value = serde_json::from_str(include_str!("../plugin.template.json")).unwrap();
    let manifest: Vec<(String, String)> = t["routes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["method"].as_str().unwrap().to_owned(),
                r["path"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let table: Vec<(String, String)> = routes::table()
        .into_iter()
        .map(|(m, p, _)| (m.to_owned(), p.to_owned()))
        .collect();
    assert_eq!(table.len(), 39);
    assert_eq!(table, manifest);
}

#[test]
fn every_job_has_a_handler() {
    let t: Value = serde_json::from_str(include_str!("../plugin.template.json")).unwrap();
    let jobs: Vec<&str> = t["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|j| j["name"].as_str().unwrap())
        .collect();
    assert_eq!(jobs.len(), 5);
    for j in jobs {
        assert!(
            fk_plugin_download::job_handler(j).is_some(),
            "{j} has no handler"
        );
    }
    assert!(fk_plugin_download::job_handler("Nope").is_none());
}

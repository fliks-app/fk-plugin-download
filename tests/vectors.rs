//! Golden vectors recorded from the TypeScript plugin at v0.12.1 (`tests/vectors/gen/gen.ts`),
//! and the manifest template against the published 0.12.1 manifest.

use fk_plugin_download::db::{IndexerRow, MIGRATIONS};
use fk_plugin_download::{client, grab, poller, routes, throttle, torznab, util};
use fliks_plugin_route::{Matcher, ParamValue};
use fliks_plugin_sdk::bindings::fliks::plugin::types::{
    AcquisitionTarget, MediaKind, Rejection, ReleaseCoverage, ScoredRelease, SeasonRef, Span, Want,
    WantDecision,
};
use serde_json::{Map, Value, json};
use std::collections::HashSet;

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

fn indexer(id: i64, settings: &Value) -> IndexerRow {
    serde_json::from_value(json!({
        "id": id, "name": "test-indexer", "implementation": "torznab", "settings": settings,
        "enableRss": true, "enableSearch": true, "enableInteractiveSearch": true, "priority": 25,
        "enabled": true, "capsSearchFallback": false, "capsMovieSearch": false, "capsTvSearch": false,
        "capsMovieSearchParams": null, "capsTvSearchParams": null, "capsProbedAt": null,
        "requestDelay": 2, "createdAt": "", "updatedAt": "",
    }))
    .unwrap()
}

#[test]
fn torznab_items() {
    for c in cases(&golden(), "torznabItems") {
        let ix = indexer(7, &c["settings"]);
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
            client::magnet_hash(c["input"].as_str().unwrap()).as_deref(),
            c["output"].as_str()
        );
    }
    for c in cases(&g, "infoHash") {
        assert_eq!(
            client::info_hash(&base64(c["input"].as_str().unwrap())).as_deref(),
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
            client::stalled_strikes(&samples, min),
            c["output"].as_i64().unwrap(),
            "{c}"
        );
    }
}

#[test]
fn qbit_base_url() {
    for c in cases(&golden(), "qbitBaseUrl") {
        let s = c["input"].as_object().unwrap().clone();
        assert_eq!(client::base_url(&s).as_deref(), c["output"].as_str(), "{c}");
    }
}

#[test]
fn progress_state() {
    for c in cases(&golden(), "progressState") {
        assert_eq!(
            client::progress_state(c["input"].as_str().unwrap()),
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

/// Every key but the ones the port changes equals the published 0.12.1 manifest; strings may
/// only be added.
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
    let (old_i18n, new_i18n) = (old["i18n"].clone(), new["i18n"].clone());
    for k in [
        "pluginApi",
        "fliks",
        "runtime",
        "memoryMb",
        "scopes",
        "network",
        "version",
        "files",
        "i18n",
    ] {
        old.as_object_mut().unwrap().remove(k);
        new.as_object_mut().unwrap().remove(k);
    }
    assert_eq!(new, old);
    for (lang, strings) in old_i18n.as_object().unwrap() {
        for (k, v) in strings.as_object().unwrap() {
            assert_eq!(&new_i18n[lang][k], v, "{lang} {k}");
        }
    }
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

fn target(want: Option<WantDecision>) -> AcquisitionTarget {
    AcquisitionTarget {
        media_id: 1,
        kind: MediaKind::Movie,
        title: String::new(),
        original_title: None,
        alternative_titles: vec![],
        year: None,
        runtime_minutes: None,
        imdb_id: None,
        tmdb_id: None,
        tvdb_id: None,
        library_id: 1,
        want: want.map(|decision| Want {
            decision,
            allowed_quality_ids: vec![],
            allowed_language_ids: vec![],
            min_resolution: 0,
            resolution_upgrade_only: false,
        }),
        expected_titles: vec![],
        search_title: String::new(),
        season: None,
        episode: None,
    }
}

fn ranked(id: u64, rejections: u64) -> grab::Ranked {
    let raw = release(&json!({ "title": id.to_string() }));
    let scored = ScoredRelease {
        id: id.to_string(),
        quality_id: 0,
        quality_name: String::new(),
        rank: 0,
        allowed: true,
        custom_format_score: 0,
        blocklisted: false,
        language_id: None,
        language_name: None,
        language_allowed: true,
        is_full_season: false,
        coverage: None,
        size_deviation: None,
        video_codec: None,
        rejections: (0..rejections)
            .map(|_| Rejection {
                code: "x".into(),
                params: vec![],
            })
            .collect(),
    };
    grab::Ranked { raw, scored }
}

#[test]
fn pick_release() {
    for c in cases(&golden(), "pickRelease") {
        let want = match c["input"]["want"]["decision"].as_str() {
            None => None,
            Some("missing") => Some(WantDecision::Missing),
            Some("upgrade") => Some(WantDecision::Upgrade),
            Some("skip") => Some(WantDecision::Skip),
            Some(d) => panic!("{d}"),
        };
        let sorted: Vec<_> = c["input"]["sorted"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| ranked(r["id"].as_u64().unwrap(), r["rejections"].as_u64().unwrap()))
            .collect();
        let got: Vec<u64> = grab::pick(&sorted, &target(want))
            .into_iter()
            .map(|i| sorted[i].scored.id.parse().unwrap())
            .collect();
        let expected: Vec<u64> = c["output"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        assert_eq!(got, expected, "{c}");
    }
}

#[test]
fn season_target_picks_packs_only() {
    let mut t = target(Some(WantDecision::Missing));
    t.season = Some(SeasonRef {
        id: 1,
        number: 1,
        episode_count: 8,
    });
    let mut sorted: Vec<_> = (1..=3).map(|id| ranked(id, 0)).collect();
    sorted[1].scored.is_full_season = true;
    assert_eq!(grab::pick(&sorted, &t), vec![1]);
}

fn release(v: &Value) -> torznab::Release {
    let mut r = json!({
        "title": "T", "downloadUrl": "https://t/x", "indexerId": 1, "indexerName": "ix", "size": 10,
        "seeders": 2, "leechers": 1, "publishDate": "2024-01-01T00:00:00.000Z", "freeleech": false,
        "downloadVolumeFactor": 1,
    });
    r.as_object_mut()
        .unwrap()
        .extend(v.as_object().unwrap().clone());
    torznab::Release {
        title: r["title"].as_str().unwrap().into(),
        download_url: r["downloadUrl"].as_str().unwrap().into(),
        info_url: None,
        indexer_id: r["indexerId"].as_i64().unwrap(),
        indexer_name: r["indexerName"].as_str().unwrap().into(),
        size: r["size"].as_i64().unwrap(),
        seeders: r["seeders"].as_i64().unwrap(),
        leechers: r["leechers"].as_i64().unwrap(),
        publish_date: r["publishDate"].as_str().map(str::to_owned),
        freeleech: r["freeleech"].as_bool().unwrap(),
        download_volume_factor: r["downloadVolumeFactor"].as_f64().unwrap(),
    }
}

#[test]
fn score_request() {
    for c in cases(&golden(), "scoreRequest") {
        let input = &c["input"];
        let releases: Vec<_> = input["releases"]
            .as_array()
            .unwrap()
            .iter()
            .map(release)
            .collect();
        let indexers: Vec<_> = input["settings"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(id, s)| indexer(id.parse().unwrap(), s))
            .collect();
        let blocked: HashSet<String> = releases
            .iter()
            .filter(|r| {
                input["blocked"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|b| b.as_str().unwrap().eq_ignore_ascii_case(&r.title))
            })
            .map(|r| r.title.clone())
            .collect();
        let got = grab::score_request(&releases, &indexers, &blocked);
        let expected = c["output"].as_array().unwrap();
        assert_eq!(got.len(), expected.len());
        for (g, e) in got.iter().zip(expected) {
            assert_eq!(
                (g.id.as_str(), g.title.as_str(), g.source_ref.as_str()),
                (
                    e["id"].as_str().unwrap(),
                    e["title"].as_str().unwrap(),
                    e["sourceRef"].as_str().unwrap()
                )
            );
            assert_eq!(
                (g.size, g.seeders, g.leechers, g.blocked),
                (
                    e["size"].as_u64().unwrap(),
                    e["seeders"].as_u64().unwrap() as u32,
                    e["leechers"].as_u64().unwrap() as u32,
                    e["blocked"].as_bool().unwrap()
                ),
                "{e}"
            );
            assert_eq!(g.publish_date, e["publishDate"].as_str().unwrap());
            assert_eq!(g.freeleech, e["freeleech"].as_bool());
            assert_eq!(g.download_volume_factor, e["downloadVolumeFactor"].as_f64());
            assert_eq!(
                g.min_seeders.map(f64::from),
                e["minSeeders"].as_f64().map(f64::ceil),
                "{e}"
            );
            assert_eq!(
                g.unknown_language_iso_code.as_deref(),
                e["unknownLanguageIsoCode"].as_str(),
                "{e}"
            );
        }
    }
}

#[test]
fn retry_after() {
    let now = util::parse_date_ms("2023-11-14T22:13:20Z").unwrap();
    let different: Vec<String> = cases(&golden(), "retryAfter")
        .iter()
        .filter(|c| {
            throttle::parse_retry_after(c["input"].as_str().unwrap(), now)
                != c["output"].as_i64().unwrap()
        })
        .map(|c| c.to_string())
        .collect();
    assert!(different.is_empty(), "{}", different.join("\n"));
}

/// The host's own matcher, tried in table order with the method upper-cased, as `Router::handle`.
fn resolve(method: &str, path: &str) -> Option<Map<String, Value>> {
    let method = method.to_ascii_uppercase();
    routes::table()
        .into_iter()
        .filter(|(m, _, _)| *m == method)
        .find_map(|(_, p, _)| Matcher::new(p).unwrap().matches(path))
        .map(|params| {
            params
                .into_iter()
                .map(|(k, v)| match v {
                    ParamValue::One(s) => (k, json!(s)),
                    ParamValue::Many(p) => (k, json!(p)),
                })
                .collect()
        })
}

#[test]
fn route_match() {
    let different: Vec<String> = cases(&golden(), "routeMatch")
        .iter()
        .filter_map(|c| {
            let got = resolve(c["method"].as_str().unwrap(), c["path"].as_str().unwrap())
                .map_or(Value::Null, Value::Object);
            (got != c["output"]).then(|| format!("{c} -> {got}"))
        })
        .collect();
    // DL7: the host's matcher ignores case and a trailing `/`, and a capture is never empty.
    assert_eq!(different.len(), 4, "{}", different.join("\n"));
    for path in ["/1/Releases", "/1/releases", "/queue/", "//releases"] {
        assert!(different.iter().any(|d| d.contains(path)), "{path}");
    }
}

//! Torznab: the feed parser (regexes ported verbatim: a real XML parser rejects the feeds they
//! tolerate), the query builder and the client behind the throttle.

use crate::db::{IndexerRow, indexer_stats, indexers};
use crate::net;
use crate::throttle::{self, Lapsed};
use crate::util::{
    decode_html_entities, encode_uri_component, parse_float, parse_int, setting_or_empty,
};
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub title: String,
    pub download_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info_url: Option<String>,
    pub indexer_id: i64,
    pub indexer_name: String,
    pub size: i64,
    pub seeders: i64,
    pub leechers: i64,
    pub publish_date: Option<String>,
    pub freeleech: bool,
    #[serde(serialize_with = "js_number")]
    pub download_volume_factor: f64,
}

#[derive(Default, Clone)]
pub struct Query<'a> {
    pub t: &'a str,
    pub q: Option<&'a str>,
    pub season: Option<u32>,
    pub ep: Option<u32>,
    pub cat: &'a str,
    pub api_key: &'a str,
    pub tvdb_id: Option<u32>,
    pub imdb_id: Option<&'a str>,
    pub tmdb_id: Option<u32>,
    pub supported_params: Option<&'a str>,
}

fn js_number<S: serde::Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    serde::Serialize::serialize(&crate::util::num(*v), s)
}

/// Drops an id the tracker does not advertise: it would answer an empty feed, not an error.
pub fn build_query(o: &Query) -> String {
    let advertised: Vec<String> = o
        .supported_params
        .unwrap_or("")
        .split(',')
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    let allows = |p: &str| advertised.iter().any(|a| a == p);
    let mut parts = vec![format!("t={}", o.t)];
    if let Some(q) = o.q.filter(|q| !q.is_empty()) {
        parts.push(format!("q={}", encode_uri_component(q)));
    }
    if let Some(s) = o.season {
        parts.push(format!("season={s}"));
    }
    if let Some(e) = o.ep {
        parts.push(format!("ep={e}"));
    }
    parts.push(format!("cat={}", o.cat));
    parts.push(format!("apikey={}", encode_uri_component(o.api_key)));
    if let Some(id) = o.tvdb_id.filter(|id| *id != 0 && allows("tvdbid")) {
        parts.push(format!("tvdbid={id}"));
    }
    if let Some(id) = o.imdb_id.filter(|id| !id.is_empty() && allows("imdbid")) {
        let stripped = if id.get(..2).is_some_and(|p| p.eq_ignore_ascii_case("tt")) {
            &id[2..]
        } else {
            id
        };
        if !stripped.is_empty() {
            parts.push(format!("imdbid={stripped}"));
        }
    }
    if let Some(id) = o.tmdb_id.filter(|id| *id != 0 && allows("tmdbid")) {
        parts.push(format!("tmdbid={id}"));
    }
    parts.join("&")
}

/// A log summary of a query URL, never the API key.
pub fn describe_query(url: &str) -> String {
    let Ok(u) = url::Url::parse(url) else {
        return "search".into();
    };
    let get = |k: &str| {
        u.query_pairs()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.into_owned())
    };
    let mut parts = vec![get("t").unwrap_or_else(|| "search".into())];
    if let Some(q) = get("q").filter(|q| !q.is_empty()) {
        parts.push(format!("q=\"{q}\""));
    }
    for k in ["season", "ep", "cat", "tvdbid", "imdbid", "tmdbid"] {
        if let Some(v) = get(k).filter(|v| !v.is_empty()) {
            parts.push(format!("{k}={v}"));
        }
    }
    parts.join(" ")
}

fn re(s: &str) -> Regex {
    Regex::new(s).expect("a valid pattern")
}

static ITEM: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)<item>([\s\S]*?)</item>"));
static CDATA: LazyLock<Regex> = LazyLock::new(|| re(r"<!\[CDATA\[|\]\]>"));
static MAGNET_DQ: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?i)name="magneturl"\s+value="([^"]*)""#));
static MAGNET_SQ: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)name='magneturl'\s+value='([^']*)'"));
static ENCLOSURE: LazyLock<Regex> = LazyLock::new(|| re(r#"(?i)<enclosure[^>]*\surl="([^"]+)""#));
static LENGTH: LazyLock<Regex> = LazyLock::new(|| re(r#"(?i)(?-u:\b)length="([0-9]+)""#));
const TAGS: [&str; 6] = ["title", "link", "size", "comments", "guid", "pubDate"];
static INNER: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    TAGS.iter()
        .map(|t| re(&format!(r"(?i)<{t}[^>]*>([\s\S]*?)</{t}>")))
        .collect()
});
const ATTRS: [&str; 5] = [
    "size",
    "seeders",
    "leechers",
    "peers",
    "downloadvolumefactor",
];
static ATTR: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    ATTRS
        .iter()
        .map(|a| {
            re(&format!(
                r#"(?i)<torznab:attr[^>]+name="{a}"[^>]+value="([^"]*)""#
            ))
        })
        .collect()
});

fn inner(block: &str, tag: &str) -> Option<String> {
    let i = TAGS.iter().position(|t| *t == tag).expect("a known tag");
    let raw = INNER[i].captures(block)?.get(1)?.as_str();
    Some(decode_html_entities(CDATA.replace_all(raw, "").trim()))
}

fn attr(block: &str, name: &str) -> Option<String> {
    let i = ATTRS.iter().position(|a| *a == name).expect("a known attr");
    Some(ATTR[i].captures(block)?.get(1)?.as_str().trim().to_owned())
}

/// The feed may carry a stale key; the configured one is forced on (magnets untouched).
fn ensure_api_key(raw: &str, api_key: &str) -> String {
    if api_key.is_empty() || raw.starts_with("magnet:") {
        return raw.to_owned();
    }
    let Ok(mut u) = url::Url::parse(&decode_html_entities(raw)) else {
        return raw.to_owned();
    };
    let mut pairs: Vec<(String, String)> = u
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    match pairs.iter().position(|(k, _)| k == "apikey") {
        Some(i) => {
            pairs[i].1 = api_key.to_owned();
            let mut n = 0;
            pairs.retain(|(k, _)| {
                k != "apikey" || {
                    n += 1;
                    n == 1
                }
            });
        }
        None => pairs.push(("apikey".into(), api_key.into())),
    }
    u.query_pairs_mut().clear().extend_pairs(pairs);
    u.to_string()
}

/// Every `<item>`; one missing a title or a usable URL is skipped, never an error.
pub fn parse_items(xml: &str, ix: &IndexerRow) -> Vec<Release> {
    let api_key = setting_or_empty(&ix.settings, "apiKey");
    let mut out = vec![];
    for m in ITEM.captures_iter(xml) {
        let block = m.get(1).map_or("", |b| b.as_str());
        let title = inner(block, "title");
        let link = inner(block, "link");
        let magnet = MAGNET_DQ
            .captures(block)
            .or_else(|| MAGNET_SQ.captures(block))
            .and_then(|c| c.get(1))
            .map(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .map(|v| decode_html_entities(v.trim()));
        let enc = ENCLOSURE.captures(block);
        let enc_url = enc
            .as_ref()
            .and_then(|c| c.get(1))
            .map(|v| decode_html_entities(v.as_str().trim()));
        let url = magnet
            .filter(|m| !m.is_empty())
            .or_else(|| link.clone().filter(|l| l.starts_with("magnet:")))
            .or_else(|| enc_url.filter(|e| !e.is_empty()))
            .or_else(|| {
                link.clone()
                    .filter(|l| !l.is_empty() && !l.starts_with("http://localhost"))
            });
        let (Some(title), Some(url)) = (title.filter(|t| !t.is_empty()), url) else {
            continue;
        };

        let enc_len = enc
            .as_ref()
            .and_then(|c| LENGTH.captures(c.get(0).map_or("", |m| m.as_str())))
            .and_then(|c| c.get(1).map(|m| m.as_str().to_owned()));
        let size_str = enc_len
            .or_else(|| attr(block, "size"))
            .or_else(|| inner(block, "size"));
        let size = size_str
            .filter(|s| !s.is_empty())
            .and_then(|s| parse_int(&s))
            .unwrap_or(0);
        let seeders = parse_int(&attr(block, "seeders").unwrap_or_else(|| "0".into())).unwrap_or(0);
        let leechers = parse_int(
            &attr(block, "leechers")
                .or_else(|| attr(block, "peers"))
                .unwrap_or_else(|| "0".into()),
        )
        .unwrap_or(0);
        let dvf = attr(block, "downloadvolumefactor").map_or(1.0, |v| parse_float(&v));

        let comments = inner(block, "comments").filter(|c| !c.is_empty());
        let guid = inner(block, "guid").filter(|g| g.starts_with("http"));
        let info_url = comments.or(guid).map(|i| decode_html_entities(i.trim()));

        let publish_date = inner(block, "pubDate")
            .filter(|d| !d.is_empty())
            .and_then(|d| crate::util::parse_date_ms(&d))
            .map(fliks_plugin_sdk::time::rfc3339);

        out.push(Release {
            title,
            download_url: ensure_api_key(&url, &api_key),
            info_url,
            indexer_id: ix.id,
            indexer_name: ix.name.clone(),
            size,
            seeders,
            leechers,
            publish_date,
            freeleech: dvf == 0.0,
            download_volume_factor: dvf,
        });
    }
    out
}

static ERROR_TAG: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)<error\s+code="));
static DESCRIPTION: LazyLock<Regex> = LazyLock::new(|| re(r#"(?i)description="([^"]*)""#));
static CAPS_TAG: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)<caps"));

/// A Torznab error is a 200 with `<error>`; it reads like an empty answer otherwise.
pub fn torznab_error(body: &str) -> Option<String> {
    if !ERROR_TAG.is_match(body) {
        return None;
    }
    Some(
        DESCRIPTION
            .captures(body)
            .map(|c| c[1].trim().to_owned())
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| "Torznab error".into()),
    )
}

pub struct CapsFound {
    pub movie: bool,
    pub tv: bool,
    pub movie_params: Option<String>,
    pub tv_params: Option<String>,
}

pub fn parse_caps(body: &str) -> CapsFound {
    static MOVIE: LazyLock<Regex> =
        LazyLock::new(|| re(r#"(?i)<movie-search\s[^>]*available="yes""#));
    static TV: LazyLock<Regex> = LazyLock::new(|| re(r#"(?i)<tv-search\s[^>]*available="yes""#));
    static MOVIE_P: LazyLock<Regex> =
        LazyLock::new(|| re(r#"(?i)<movie-search\s[^>]*supportedParams="([^"]*)""#));
    static TV_P: LazyLock<Regex> =
        LazyLock::new(|| re(r#"(?i)<tv-search\s[^>]*supportedParams="([^"]*)""#));
    let params = |r: &Regex| {
        r.captures(body)
            .map(|c| c[1].trim().to_owned())
            .filter(|p| !p.is_empty())
    };
    CapsFound {
        movie: MOVIE.is_match(body),
        tv: TV.is_match(body),
        movie_params: params(&MOVIE_P),
        tv_params: params(&TV_P),
    }
}

/// A status outside the accepted range, or a transport failure.
pub enum FetchError {
    Status {
        status: u16,
        retry_after: Option<String>,
    },
    Transport(String),
}

impl FetchError {
    fn message(&self) -> String {
        match self {
            FetchError::Status { status, .. } => format!("HTTP {status}"),
            FetchError::Transport(m) => m.clone(),
        }
    }
}

/// GET with `validateStatus: 200..400`.
fn fetch_ok(url: &str, timeout: Duration) -> Result<String, FetchError> {
    let r = net::get_following(url, &[], timeout).map_err(FetchError::Transport)?;
    if !(200..400).contains(&r.status) {
        return Err(FetchError::Status {
            status: r.status,
            retry_after: r.header("retry-after"),
        });
    }
    Ok(r.text())
}

fn on_failure(ix: &IndexerRow, e: &FetchError) {
    if let FetchError::Status {
        status: 429 | 503,
        retry_after,
    } = e
    {
        throttle::set_retry_after(ix, retry_after.as_deref());
    }
    throttle::notify_failure(ix, &e.message());
}

fn record(ix: &IndexerRow, query_type: &str, start: Instant, count: usize, error: Option<&str>) {
    let ms = start.elapsed().as_millis() as i64;
    if let Err(e) = indexer_stats::insert(ix.id, query_type, ms, count as i64, error) {
        warn!("[{}] stats not recorded: {e}", ix.name);
    }
}

/// The endpoint whatever the gates; `None` when unresolvable.
fn endpoint(ix: &IndexerRow) -> Option<(String, String)> {
    if !ix.implementation.to_lowercase().contains("torznab") {
        info!(
            "[{}] skipped — implementation \"{}\" is not Torznab",
            ix.name, ix.implementation
        );
        return None;
    }
    let base = setting_or_empty(&ix.settings, "baseUrl");
    let base = base.strip_suffix('/').unwrap_or(&base).to_owned();
    if base.is_empty() {
        warn!("Indexer \"{}\" has no baseUrl", ix.name);
        return None;
    }
    Some((base, setting_or_empty(&ix.settings, "apiKey")))
}

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Auto,
    Manual,
}

/// One search round: every request ends by `until`, each at most `fetch_timeout`.
#[derive(Clone, Copy)]
pub struct Round {
    pub until: Instant,
    pub fetch_timeout: Duration,
}

/// `t=caps`, persisted with a clean `capsSearchFallback`; nothing is written on a failure.
pub fn refresh_caps(ix: &mut IndexerRow, round: Round) -> Result<(), Lapsed> {
    let Some((base, key)) = endpoint(ix) else {
        return Ok(());
    };
    let url = format!("{base}?t=caps&apikey={}", encode_uri_component(&key));
    let res = throttle::run(ix, round.until, Duration::from_secs(10), |t| {
        fetch_ok(&url, t)
    })?;
    let body = match res {
        Ok(b) => b,
        Err(e) => {
            on_failure(ix, &e);
            warn!("[{}] caps fetch failed: {}", ix.name, e.message());
            return Ok(());
        }
    };
    if let Some(err) = torznab_error(&body) {
        throttle::notify_failure(ix, &err);
        warn!("[{}] caps refused: {err}", ix.name);
        return Ok(());
    }
    let c = parse_caps(&body);
    let show = |p: &Option<String>| p.clone().unwrap_or_else(|| "null".into());
    info!(
        "[{}] caps refreshed — movieSearch={} ({}), tvSearch={} ({})",
        ix.name,
        c.movie,
        show(&c.movie_params),
        c.tv,
        show(&c.tv_params)
    );
    let caps = indexers::Caps {
        movie: c.movie,
        tv: c.tv,
        movie_params: c.movie_params,
        tv_params: c.tv_params,
    };
    if let Err(e) = indexers::refresh_caps(ix.id, &caps) {
        warn!("[{}] caps not saved: {e}", ix.name);
        return Ok(());
    }
    ix.caps_movie_search = caps.movie;
    ix.caps_tv_search = caps.tv;
    ix.caps_movie_search_params = caps.movie_params;
    ix.caps_tv_search_params = caps.tv_params;
    ix.caps_search_fallback = false;
    ix.caps_probed_at = Some(crate::util::now_iso());
    Ok(())
}

/// Probes on first use; false when the probe left the indexer cooling down.
fn ensure_caps(ix: &mut IndexerRow, round: Round) -> Result<bool, Lapsed> {
    if ix.caps_probed_at.is_some() || throttle::cooling(ix.id) {
        return Ok(true);
    }
    refresh_caps(ix, round)?;
    Ok(!throttle::cooling(ix.id))
}

fn search_target(ix: &IndexerRow, kind: Kind) -> Option<(String, String)> {
    if !ix.enabled {
        info!("[{}] skipped — indexer disabled", ix.name);
        return None;
    }
    if kind == Kind::Auto && !ix.enable_search {
        info!("[{}] skipped: automatic search disabled", ix.name);
        return None;
    }
    if kind == Kind::Manual && !ix.enable_interactive_search {
        info!("[{}] skipped: manual search disabled", ix.name);
        return None;
    }
    endpoint(ix)
}

/// Results, or the Torznab/transport error text.
fn exec_search(
    url: &str,
    query_type: &str,
    ix: &IndexerRow,
    round: Round,
) -> Result<Result<Vec<Release>, String>, Lapsed> {
    let query = describe_query(url);
    let start = Instant::now();
    match throttle::run(ix, round.until, round.fetch_timeout, |t| fetch_ok(url, t))? {
        Ok(body) => {
            if let Some(msg) = torznab_error(&body) {
                record(ix, query_type, start, 0, Some(&msg));
                warn!("[{}] {query} → {msg}", ix.name);
                return Ok(Err(msg));
            }
            let results = parse_items(&body, ix);
            record(ix, query_type, start, results.len(), None);
            info!(
                "[{}] {query} → {} result(s) in {}ms",
                ix.name,
                results.len(),
                start.elapsed().as_millis()
            );
            Ok(Ok(results))
        }
        Err(e) => {
            on_failure(ix, &e);
            let msg = e.message();
            record(ix, query_type, start, 0, Some(&msg));
            warn!("[{}] {query} failed: {msg}", ix.name);
            Ok(Err(msg))
        }
    }
}

fn retry_with_fallback(
    ix: &mut IndexerRow,
    url: &str,
    query_type: &str,
    round: Round,
) -> Result<Vec<Release>, Lapsed> {
    let Ok(results) = exec_search(url, query_type, ix, round)? else {
        return Ok(vec![]);
    };
    info!(
        "[{}] t=search fallback succeeded — saving capsSearchFallback=true",
        ix.name
    );
    if let Err(e) = indexers::mark_search_fallback(ix.id) {
        warn!("[{}] could not persist the search fallback: {e}", ix.name);
    }
    ix.caps_search_fallback = true;
    Ok(results)
}

/// Validates a URL and key before a row exists; bypasses the throttle.
pub fn test_connection(base_url: &str, api_key: &str) -> serde_json::Value {
    use serde_json::json;
    let base = base_url.strip_suffix('/').unwrap_or(base_url);
    if base.is_empty() {
        return json!({ "ok": false, "messageKey": "download.indexers.test.base_url_missing" });
    }
    let url = format!("{base}?t=caps&apikey={}", encode_uri_component(api_key));
    match net::get_following(&url, &[], Duration::from_secs(30)) {
        Err(e) => {
            json!({ "ok": false, "messageKey": "download.indexers.test.network_error", "detail": e })
        }
        Ok(r) if r.status >= 400 => {
            json!({ "ok": false, "messageKey": "download.indexers.test.http_error", "detail": r.status.to_string() })
        }
        Ok(r) => {
            let body = r.text();
            if ERROR_TAG.is_match(&body) {
                let mut v =
                    json!({ "ok": false, "messageKey": "download.indexers.test.torznab_error" });
                if let Some(d) = DESCRIPTION.captures(&body).map(|c| c[1].trim().to_owned()) {
                    v["detail"] = json!(d);
                }
                v
            } else if !CAPS_TAG.is_match(&body) {
                json!({ "ok": false, "messageKey": "download.indexers.test.unexpected_response" })
            } else {
                json!({ "ok": true, "messageKey": "download.indexers.test.ok" })
            }
        }
    }
}

/// The RSS feed: `t=search` with no query.
pub fn rss(ix: &IndexerRow, until: Instant) -> Result<Vec<Release>, Lapsed> {
    if !ix.enabled || !ix.enable_rss {
        return Ok(vec![]);
    }
    let Some((base, key)) = endpoint(ix) else {
        return Ok(vec![]);
    };
    let url = format!(
        "{base}?t=search&q=&cat=2000&apikey={}",
        encode_uri_component(&key)
    );
    let start = Instant::now();
    match throttle::run(ix, until, Duration::from_secs(60), |t| fetch_ok(&url, t))? {
        Ok(body) => {
            let results = parse_items(&body, ix);
            record(ix, "rss", start, results.len(), None);
            Ok(results)
        }
        Err(e) => {
            on_failure(ix, &e);
            record(ix, "rss", start, 0, Some(&e.message()));
            warn!("RSS sync failed for \"{}\": {}", ix.name, e.message());
            Ok(vec![])
        }
    }
}

pub struct Ids<'a> {
    pub imdb: Option<&'a str>,
    pub tmdb: Option<u32>,
    pub tvdb: Option<u32>,
}

fn season_tag(title: &str, season: u32) -> String {
    format!("{title} S{season:02}")
}

pub fn search_season_pack(
    ix: &mut IndexerRow,
    kind: Kind,
    title: &str,
    season: u32,
    ids: &Ids,
    round: Round,
) -> Result<Vec<Release>, Lapsed> {
    let Some((base, key)) = search_target(ix, kind) else {
        return Ok(vec![]);
    };
    if !ensure_caps(ix, round)? {
        return Ok(vec![]);
    }
    let tv = ix.caps_tv_search && !ix.caps_search_fallback;
    let q = if tv {
        title.to_owned()
    } else {
        season_tag(title, season)
    };
    let url = format!(
        "{base}?{}",
        build_query(&Query {
            t: if tv { "tvsearch" } else { "search" },
            q: Some(&q),
            season: tv.then_some(season),
            cat: "5000",
            api_key: &key,
            tvdb_id: ids.tvdb.filter(|_| tv),
            imdb_id: ids.imdb.filter(|_| tv),
            supported_params: ix.caps_tv_search_params.as_deref(),
            ..Default::default()
        })
    );
    match exec_search(&url, "season", ix, round)? {
        Ok(r) => Ok(r),
        Err(err) if tv => {
            warn!(
                "[{}] tvsearch failed ({err}), falling back to t=search",
                ix.name
            );
            let fq = season_tag(title, season);
            let fb = format!(
                "{base}?{}",
                build_query(&Query {
                    t: "search",
                    q: Some(&fq),
                    cat: "5000",
                    api_key: &key,
                    ..Default::default()
                })
            );
            retry_with_fallback(ix, &fb, "season", round)
        }
        Err(_) => Ok(vec![]),
    }
}

pub fn search_series(
    ix: &mut IndexerRow,
    kind: Kind,
    title: &str,
    season: u32,
    episode: u32,
    ids: &Ids,
    round: Round,
) -> Result<Vec<Release>, Lapsed> {
    let Some((base, key)) = search_target(ix, kind) else {
        return Ok(vec![]);
    };
    if !ensure_caps(ix, round)? {
        return Ok(vec![]);
    }
    // A special is never published as S00E03; the caller put its title in `title`.
    let special = season == 0;
    let tv = ix.caps_tv_search && !ix.caps_search_fallback && !special;
    let q = if tv || special {
        title.to_owned()
    } else {
        season_tag(title, season)
    };
    let url = format!(
        "{base}?{}",
        build_query(&Query {
            t: if tv { "tvsearch" } else { "search" },
            q: Some(&q),
            season: tv.then_some(season),
            ep: tv.then_some(episode),
            cat: "5000",
            api_key: &key,
            tvdb_id: ids.tvdb.filter(|_| tv),
            imdb_id: ids.imdb.filter(|_| tv),
            supported_params: ix.caps_tv_search_params.as_deref(),
            ..Default::default()
        })
    );
    match exec_search(&url, "tvsearch", ix, round)? {
        Ok(r) => Ok(r),
        Err(err) if tv => {
            warn!(
                "[{}] tvsearch failed ({err}), falling back to t=search",
                ix.name
            );
            let fq = season_tag(title, season);
            let fb = format!(
                "{base}?{}",
                build_query(&Query {
                    t: "search",
                    q: Some(&fq),
                    cat: "5000",
                    api_key: &key,
                    ..Default::default()
                })
            );
            retry_with_fallback(ix, &fb, "tvsearch", round)
        }
        Err(_) => Ok(vec![]),
    }
}

pub fn search_movie(
    ix: &mut IndexerRow,
    kind: Kind,
    query: &str,
    ids: &Ids,
    round: Round,
) -> Result<Vec<Release>, Lapsed> {
    let Some((base, key)) = search_target(ix, kind) else {
        return Ok(vec![]);
    };
    if !ensure_caps(ix, round)? {
        return Ok(vec![]);
    }
    let has_id = ids.imdb.is_some_and(|i| !i.is_empty()) || ids.tmdb.is_some_and(|i| i != 0);
    let movie = ix.caps_movie_search && !ix.caps_search_fallback && has_id;
    let url = format!(
        "{base}?{}",
        build_query(&Query {
            t: if movie { "movie" } else { "search" },
            q: Some(query),
            cat: "2000",
            api_key: &key,
            imdb_id: ids.imdb.filter(|_| movie),
            tmdb_id: ids.tmdb.filter(|_| movie),
            supported_params: ix.caps_movie_search_params.as_deref(),
            ..Default::default()
        })
    );
    match exec_search(&url, "search", ix, round)? {
        Ok(r) => Ok(r),
        Err(err) if movie => {
            warn!(
                "[{}] t=movie failed ({err}), falling back to t=search",
                ix.name
            );
            let fb = format!(
                "{base}?{}",
                build_query(&Query {
                    t: "search",
                    q: Some(query),
                    cat: "2000",
                    api_key: &key,
                    ..Default::default()
                })
            );
            retry_with_fallback(ix, &fb, "search", round)
        }
        Err(err) => {
            warn!("[{}] search failed: {err}", ix.name);
            Ok(vec![])
        }
    }
}

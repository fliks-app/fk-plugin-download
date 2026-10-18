//! Rows of the plugin schema and every statement on them. One statement per `db` call: there is
//! no transaction across calls (plugins.md rule 35).

use crate::error::R;
use crate::util::Settings;
use fliks_plugin_sdk::db::{self as sdk, Param, Value};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};

pub const MIGRATIONS: [(&str, &str); 11] = [
    (
        "0001_initial_schema",
        include_str!("../migrations/0001_initial_schema.sql"),
    ),
    (
        "0002_indexer_caps_probed_at",
        include_str!("../migrations/0002_indexer_caps_probed_at.sql"),
    ),
    (
        "0003_download_history_size",
        include_str!("../migrations/0003_download_history_size.sql"),
    ),
    (
        "0004_download_history_info_url",
        include_str!("../migrations/0004_download_history_info_url.sql"),
    ),
    (
        "0005_indexer_sources",
        include_str!("../migrations/0005_indexer_sources.sql"),
    ),
    (
        "0006_indexer_interactive_search",
        include_str!("../migrations/0006_indexer_interactive_search.sql"),
    ),
    (
        "0007_indexer_caps_supported_params",
        include_str!("../migrations/0007_indexer_caps_supported_params.sql"),
    ),
    (
        "0008_download_history_coverage",
        include_str!("../migrations/0008_download_history_coverage.sql"),
    ),
    (
        "0009_indexer_throttle",
        include_str!("../migrations/0009_indexer_throttle.sql"),
    ),
    (
        "0010_poller_state",
        include_str!("../migrations/0010_poller_state.sql"),
    ),
    (
        "0011_download_history_import_lease",
        include_str!("../migrations/0011_download_history_import_lease.sql"),
    ),
];

fn json_of(v: &Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Boolean(b) => Json::Bool(*b),
        Value::Int(i) => Json::from(*i),
        Value::Float(f) => Json::from(*f),
        Value::Text(t) => Json::String(t.clone()),
        Value::Bytes(b) => Json::from(b.clone()),
        Value::Json(t) => serde_json::from_str(t).unwrap_or(Json::Null),
    }
}

/// Every row as `T`, decoded from a JSON object keyed by column name.
pub fn query<T: DeserializeOwned>(sql: &str, params: &[Param]) -> R<Vec<T>> {
    let rs = sdk::query(sql, params)?.0;
    rs.rows
        .iter()
        .map(|row| {
            let obj: Map<String, Json> = rs
                .columns
                .iter()
                .cloned()
                .zip(row.iter().map(json_of))
                .collect();
            serde_json::from_value(Json::Object(obj))
                .map_err(|e| crate::error::Error::Other(format!("row decode: {e}")))
        })
        .collect()
}

pub fn first<T: DeserializeOwned>(sql: &str, params: &[Param]) -> R<Option<T>> {
    Ok(query(sql, params)?.into_iter().next())
}

pub fn exec(sql: &str, params: &[Param]) -> R<u64> {
    Ok(sdk::execute(sql, params)?)
}

pub fn int(v: i64) -> Param {
    Param::Int(v)
}
pub fn opt_int(v: Option<i64>) -> Param {
    v.map_or(Param::Null, Param::Int)
}
pub fn text(v: &str) -> Param {
    Param::Text(v.into())
}
pub fn opt_text(v: Option<&str>) -> Param {
    v.map_or(Param::Null, text)
}
pub fn json(v: &Settings) -> Param {
    Param::Json(Json::Object(v.clone()).to_string())
}
/// A JSON number as the column wants it: `2.5` stays a float, so Postgres refuses it as Node's did.
pub fn number(v: f64) -> Param {
    if v.fract() == 0.0 {
        Param::Int(v as i64)
    } else {
        Param::Float(v)
    }
}

#[derive(Deserialize)]
struct Count {
    count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexerRow {
    pub id: i64,
    pub name: String,
    pub implementation: String,
    pub settings: Settings,
    pub enable_rss: bool,
    pub enable_search: bool,
    pub enable_interactive_search: bool,
    pub priority: i64,
    pub enabled: bool,
    pub caps_search_fallback: bool,
    pub caps_movie_search: bool,
    pub caps_tv_search: bool,
    pub caps_movie_search_params: Option<String>,
    pub caps_tv_search_params: Option<String>,
    pub caps_probed_at: Option<String>,
    pub request_delay: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexerSourceRow {
    pub id: i64,
    pub name: String,
    pub implementation: String,
    pub settings: Settings,
    pub priority: i64,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadClientRow {
    pub id: i64,
    pub name: String,
    pub implementation: String,
    pub settings: Settings,
    pub enabled: bool,
    pub priority: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub cover_season_from: Option<i64>,
    pub cover_season_to: Option<i64>,
    pub cover_episode_from: Option<i64>,
    pub cover_episode_to: Option<i64>,
    pub cover_complete_series: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub id: i64,
    pub source_title: String,
    pub quality: String,
    pub language: Option<String>,
    pub torrent_hash: Option<String>,
    pub size: Option<i64>,
    pub info_url: Option<String>,
    pub status: String,
    pub status_message: Option<String>,
    pub grab_source: String,
    pub media_id: Option<i64>,
    pub episode_id: Option<i64>,
    pub season_id: Option<i64>,
    pub indexer_id: Option<i64>,
    pub download_client_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub coverage: Coverage,
}

impl HistoryRow {
    pub fn is_live(&self) -> bool {
        self.status == "grabbed" || self.status == "importing"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlocklistRow {
    pub id: i64,
    pub source_title: String,
    pub indexer_name: Option<String>,
    pub download_url: Option<String>,
    pub quality: Option<String>,
    pub note: Option<String>,
    pub indexer_id: Option<i64>,
    pub media_id: Option<i64>,
    pub user_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StalledCheckRow {
    pub downloaded_bytes: i64,
    pub checked_at: String,
}

pub mod indexers {
    use super::*;

    const COLUMNS: &str = r#""id", "name", "implementation", "settings", "enableRss", "enableSearch",
  "enableInteractiveSearch", "priority", "enabled", "capsSearchFallback", "capsMovieSearch",
  "capsTvSearch", "capsMovieSearchParams", "capsTvSearchParams", "capsProbedAt",
  "requestDelay", "createdAt", "updatedAt""#;

    pub struct Fields {
        pub name: String,
        pub implementation: String,
        pub settings: Settings,
        pub enable_rss: bool,
        pub enable_search: bool,
        pub enable_interactive_search: bool,
        pub priority: f64,
        pub request_delay: f64,
        pub enabled: bool,
    }

    pub fn list_enabled() -> R<Vec<IndexerRow>> {
        query(
            &format!(
                r#"SELECT {COLUMNS} FROM "indexers" WHERE "enabled" = true ORDER BY "priority" ASC, "id" ASC"#
            ),
            &[],
        )
    }

    pub fn list_all() -> R<Vec<IndexerRow>> {
        query(
            &format!(r#"SELECT {COLUMNS} FROM "indexers" ORDER BY "priority" ASC, "id" ASC"#),
            &[],
        )
    }

    pub fn find(id: i64) -> R<Option<IndexerRow>> {
        first(
            &format!(r#"SELECT {COLUMNS} FROM "indexers" WHERE "id" = $1"#),
            &[int(id)],
        )
    }

    pub fn find_by_base_url(base_url: &str) -> R<Option<IndexerRow>> {
        first(
            &format!(
                r#"SELECT {COLUMNS} FROM "indexers" WHERE "settings"->>'baseUrl' = $1 ORDER BY "id" ASC LIMIT 1"#
            ),
            &[text(base_url)],
        )
    }

    pub fn insert(f: &Fields) -> R<IndexerRow> {
        let sql = format!(
            r#"INSERT INTO "indexers"
         ("name", "implementation", "settings", "enableRss", "enableSearch", "enableInteractiveSearch",
          "priority", "requestDelay", "enabled")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING {COLUMNS}"#
        );
        first(
            &sql,
            &[
                text(&f.name),
                text(&f.implementation),
                json(&f.settings),
                f.enable_rss.into(),
                f.enable_search.into(),
                f.enable_interactive_search.into(),
                number(f.priority),
                number(f.request_delay),
                f.enabled.into(),
            ],
        )?
        .ok_or_else(|| {
            crate::error::Error::Other(r#"insert into "indexers" returned no row"#.into())
        })
    }

    pub fn update(id: i64, f: &Fields) -> R<IndexerRow> {
        let sql = format!(
            r#"UPDATE "indexers" SET
         "name" = $2, "implementation" = $3, "enableRss" = $4, "enableSearch" = $5,
         "enableInteractiveSearch" = $6, "priority" = $7, "requestDelay" = $8, "enabled" = $9,
         "settings" = $10, "updatedAt" = now()
       WHERE "id" = $1
       RETURNING {COLUMNS}"#
        );
        first(
            &sql,
            &[
                int(id),
                text(&f.name),
                text(&f.implementation),
                f.enable_rss.into(),
                f.enable_search.into(),
                f.enable_interactive_search.into(),
                number(f.priority),
                number(f.request_delay),
                f.enabled.into(),
                json(&f.settings),
            ],
        )?
        .ok_or_else(|| crate::error::Error::Other(format!(r#""indexers" row {id} not found"#)))
    }

    pub fn update_settings(id: i64, settings: &Settings) -> R<()> {
        exec(
            r#"UPDATE "indexers" SET "settings" = $2, "updatedAt" = now() WHERE "id" = $1"#,
            &[int(id), json(settings)],
        )
        .map(drop)
    }

    pub struct Caps {
        pub movie: bool,
        pub tv: bool,
        pub movie_params: Option<String>,
        pub tv_params: Option<String>,
    }

    pub fn refresh_caps(id: i64, c: &Caps) -> R<()> {
        exec(
            r#"UPDATE "indexers" SET "capsMovieSearch" = $2, "capsTvSearch" = $3, "capsSearchFallback" = $4,
              "capsMovieSearchParams" = $5, "capsTvSearchParams" = $6,
              "capsProbedAt" = NOW() WHERE "id" = $1"#,
            &[
                int(id),
                c.movie.into(),
                c.tv.into(),
                false.into(),
                opt_text(c.movie_params.as_deref()),
                opt_text(c.tv_params.as_deref()),
            ],
        )
        .map(drop)
    }

    pub fn mark_search_fallback(id: i64) -> R<()> {
        exec(
            r#"UPDATE "indexers" SET "capsSearchFallback" = true WHERE "id" = $1"#,
            &[int(id)],
        )
        .map(drop)
    }

    pub fn remove(id: i64) -> R<()> {
        exec(r#"DELETE FROM "indexers" WHERE "id" = $1"#, &[int(id)]).map(drop)
    }
}

pub mod indexer_stats {
    use super::*;

    pub fn insert(
        indexer_id: i64,
        query_type: &str,
        response_time_ms: i64,
        result_count: i64,
        error: Option<&str>,
    ) -> R<()> {
        exec(
            r#"INSERT INTO "indexer_stats" ("indexerId", "queryType", "responseTimeMs", "resultCount", "errorMessage")
       VALUES ($1, $2, $3, $4, $5)"#,
            &[int(indexer_id), text(query_type), int(response_time_ms), int(result_count), opt_text(error)],
        )
        .map(drop)
    }

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Daily {
        date: String,
        queries: i64,
        avg_response_ms: i64,
        total_results: i64,
        errors: i64,
    }

    /// The last 30 days, newest first.
    pub fn daily(indexer_id: i64) -> R<Vec<Daily>> {
        query(
            r#"SELECT DATE("queryDate")::text AS "date",
              COUNT(*)::int AS "queries",
              AVG("responseTimeMs")::int AS "avgResponseMs",
              SUM("resultCount")::int AS "totalResults",
              SUM(CASE WHEN "errorMessage" IS NOT NULL THEN 1 ELSE 0 END)::int AS "errors"
         FROM "indexer_stats"
        WHERE "indexerId" = $1 AND "queryDate" >= now() - interval '30 days'
        GROUP BY DATE("queryDate")
        ORDER BY "date" DESC"#,
            &[int(indexer_id)],
        )
    }
}

pub mod indexer_sources {
    use super::*;

    const COLUMNS: &str = r#""id", "name", "implementation", "settings", "priority", "enabled", "createdAt", "updatedAt""#;

    pub struct Fields {
        pub name: String,
        pub implementation: String,
        pub settings: Settings,
        pub priority: f64,
        pub enabled: bool,
    }

    pub fn list_all() -> R<Vec<IndexerSourceRow>> {
        query(
            &format!(
                r#"SELECT {COLUMNS} FROM "indexer_sources" ORDER BY "priority" ASC, "id" ASC"#
            ),
            &[],
        )
    }

    pub fn find(id: i64) -> R<Option<IndexerSourceRow>> {
        first(
            &format!(r#"SELECT {COLUMNS} FROM "indexer_sources" WHERE "id" = $1"#),
            &[int(id)],
        )
    }

    fn params(f: &Fields) -> [Param; 5] {
        [
            text(&f.name),
            text(&f.implementation),
            json(&f.settings),
            number(f.priority),
            f.enabled.into(),
        ]
    }

    pub fn insert(f: &Fields) -> R<IndexerSourceRow> {
        let sql = format!(
            r#"INSERT INTO "indexer_sources" ("name", "implementation", "settings", "priority", "enabled")
       VALUES ($1, $2, $3, $4, $5)
       RETURNING {COLUMNS}"#
        );
        first(&sql, &params(f))?.ok_or_else(|| {
            crate::error::Error::Other(r#"insert into "indexer_sources" returned no row"#.into())
        })
    }

    pub fn update(id: i64, f: &Fields) -> R<IndexerSourceRow> {
        let sql = format!(
            r#"UPDATE "indexer_sources" SET
         "name" = $2, "implementation" = $3, "settings" = $4, "priority" = $5, "enabled" = $6,
         "updatedAt" = now()
       WHERE "id" = $1
       RETURNING {COLUMNS}"#
        );
        let mut p = vec![int(id)];
        p.extend(params(f));
        first(&sql, &p)?.ok_or_else(|| {
            crate::error::Error::Other(format!(r#""indexer_sources" row {id} not found"#))
        })
    }

    pub fn remove(id: i64) -> R<()> {
        exec(
            r#"DELETE FROM "indexer_sources" WHERE "id" = $1"#,
            &[int(id)],
        )
        .map(drop)
    }
}

pub mod clients {
    use super::*;

    const COLUMNS: &str = r#""id", "name", "implementation", "settings", "enabled", "priority", "createdAt", "updatedAt""#;

    pub struct Fields {
        pub name: String,
        pub implementation: String,
        pub settings: Settings,
        pub enabled: bool,
        pub priority: f64,
    }

    pub fn list_enabled() -> R<Vec<DownloadClientRow>> {
        query(
            &format!(
                r#"SELECT {COLUMNS} FROM "download_clients" WHERE "enabled" = true ORDER BY "priority" ASC, "id" ASC"#
            ),
            &[],
        )
    }

    pub fn list_all() -> R<Vec<DownloadClientRow>> {
        query(
            &format!(
                r#"SELECT {COLUMNS} FROM "download_clients" ORDER BY "priority" ASC, "id" ASC"#
            ),
            &[],
        )
    }

    pub fn find(id: i64) -> R<Option<DownloadClientRow>> {
        first(
            &format!(r#"SELECT {COLUMNS} FROM "download_clients" WHERE "id" = $1"#),
            &[int(id)],
        )
    }

    fn params(f: &Fields) -> [Param; 5] {
        [
            text(&f.name),
            text(&f.implementation),
            json(&f.settings),
            f.enabled.into(),
            number(f.priority),
        ]
    }

    pub fn insert(f: &Fields) -> R<DownloadClientRow> {
        let sql = format!(
            r#"INSERT INTO "download_clients" ("name", "implementation", "settings", "enabled", "priority")
       VALUES ($1, $2, $3, $4, $5)
       RETURNING {COLUMNS}"#
        );
        first(&sql, &params(f))?.ok_or_else(|| {
            crate::error::Error::Other(r#"insert into "download_clients" returned no row"#.into())
        })
    }

    pub fn update(id: i64, f: &Fields) -> R<DownloadClientRow> {
        let sql = format!(
            r#"UPDATE "download_clients" SET
         "name" = $2, "implementation" = $3, "settings" = $4, "enabled" = $5, "priority" = $6, "updatedAt" = now()
       WHERE "id" = $1
       RETURNING {COLUMNS}"#
        );
        let mut p = vec![int(id)];
        p.extend(params(f));
        first(&sql, &p)?.ok_or_else(|| {
            crate::error::Error::Other(format!(r#""download_clients" row {id} not found"#))
        })
    }

    pub fn remove(id: i64) -> R<()> {
        exec(
            r#"DELETE FROM "download_clients" WHERE "id" = $1"#,
            &[int(id)],
        )
        .map(drop)
    }
}

pub mod blocklist {
    use super::*;

    const COLUMNS: &str = r#""id", "sourceTitle", "indexerName", "downloadUrl", "quality", "note",
  "indexerId", "mediaId", "userId", "createdAt", "updatedAt""#;

    #[derive(Default)]
    pub struct Entry<'a> {
        pub source_title: &'a str,
        pub indexer_id: Option<i64>,
        pub indexer_name: Option<&'a str>,
        pub quality: Option<&'a str>,
        pub media_id: Option<i64>,
        pub note: Option<&'a str>,
    }

    pub fn insert(e: &Entry) -> R<()> {
        exec(
            r#"INSERT INTO "blocklist"
         ("sourceTitle", "indexerId", "indexerName", "downloadUrl", "quality", "mediaId", "note", "userId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"#,
            &[
                text(e.source_title),
                opt_int(e.indexer_id),
                opt_text(e.indexer_name),
                Param::Null,
                opt_text(e.quality),
                opt_int(e.media_id),
                opt_text(e.note),
                Param::Null,
            ],
        )
        .map(drop)
    }

    pub fn list(limit: i64, offset: i64) -> R<(Vec<BlocklistRow>, i64)> {
        let items = query(
            &format!(
                r#"SELECT {COLUMNS} FROM "blocklist" ORDER BY "createdAt" DESC LIMIT $1 OFFSET $2"#
            ),
            &[int(limit), int(offset)],
        )?;
        let total: Option<Count> =
            first(r#"SELECT COUNT(*)::int AS "count" FROM "blocklist""#, &[])?;
        Ok((items, total.map_or(0, |c| c.count)))
    }

    /// The titles among `titles` that are blocklisted, case folded by Postgres on both sides.
    pub fn blocked(titles: &[String]) -> R<std::collections::HashSet<String>> {
        #[derive(Deserialize)]
        struct T {
            t: String,
        }
        let rows: Vec<T> = query(
            r#"SELECT "t" FROM unnest($1::text[]) AS "t" WHERE EXISTS (SELECT 1 FROM "blocklist" WHERE LOWER("sourceTitle") = LOWER("t"))"#,
            &[Param::TextList(titles.to_vec())],
        )?;
        Ok(rows.into_iter().map(|r| r.t).collect())
    }

    pub fn find(id: i64) -> R<Option<BlocklistRow>> {
        first(
            &format!(r#"SELECT {COLUMNS} FROM "blocklist" WHERE "id" = $1"#),
            &[int(id)],
        )
    }

    pub fn remove(id: i64) -> R<()> {
        exec(r#"DELETE FROM "blocklist" WHERE "id" = $1"#, &[int(id)]).map(drop)
    }

    pub fn clear() -> R<()> {
        exec(r#"DELETE FROM "blocklist""#, &[]).map(drop)
    }
}

pub mod stalled {
    use super::*;

    pub fn insert(hash: &str, bytes: i64) -> R<()> {
        exec(
            r#"INSERT INTO "stalled_checks" ("torrentHash", "downloadedBytes") VALUES ($1, $2)"#,
            &[text(hash), int(bytes)],
        )
        .map(drop)
    }

    /// Newest first.
    pub fn recent(hash: &str, limit: i64) -> R<Vec<StalledCheckRow>> {
        query(
            r#"SELECT "downloadedBytes", "checkedAt" FROM "stalled_checks" WHERE "torrentHash" = $1 ORDER BY "checkedAt" DESC LIMIT $2"#,
            &[text(hash), int(limit)],
        )
    }

    pub fn delete_by_hash(hash: &str) -> R<()> {
        exec(
            r#"DELETE FROM "stalled_checks" WHERE "torrentHash" = $1"#,
            &[text(hash)],
        )
        .map(drop)
    }

    pub fn prune_older_than_secs(secs: f64) -> R<u64> {
        exec(
            r#"DELETE FROM "stalled_checks" WHERE "checkedAt" < now() - make_interval(secs => $1)"#,
            &[Param::Float(secs)],
        )
    }
}

pub mod history {
    use super::*;

    const COLUMNS: &str = r#""id", "sourceTitle", "quality", "language", "torrentHash", "size", "infoUrl", "status", "statusMessage",
  "grabSource", "mediaId", "episodeId", "seasonId", "indexerId", "downloadClientId", "createdAt", "updatedAt",
  "coverSeasonFrom", "coverSeasonTo", "coverEpisodeFrom", "coverEpisodeTo", "coverCompleteSeries""#;

    pub struct Grab {
        pub source_title: String,
        pub quality: String,
        pub torrent_hash: Option<String>,
        pub size: Option<i64>,
        pub info_url: Option<String>,
        pub grab_source: &'static str,
        pub media_id: i64,
        pub episode_id: Option<i64>,
        pub season_id: Option<i64>,
        pub indexer_id: Option<i64>,
        pub download_client_id: Option<i64>,
        pub coverage: Coverage,
    }

    fn cov(c: &Coverage) -> [Param; 5] {
        [
            opt_int(c.cover_season_from),
            opt_int(c.cover_season_to),
            opt_int(c.cover_episode_from),
            opt_int(c.cover_episode_to),
            c.cover_complete_series.into(),
        ]
    }

    pub fn find_pending_for_media(media_id: i64) -> R<Option<HistoryRow>> {
        first(
            &format!(
                r#"SELECT {COLUMNS} FROM "download_history" WHERE "mediaId" = $1 AND "status" IN ('grabbed', 'importing') LIMIT 1"#
            ),
            &[int(media_id)],
        )
    }

    pub struct Covering {
        pub media_id: i64,
        pub season_id: i64,
        pub season_number: i64,
        pub episode_number: Option<i64>,
        pub episode_tag_pattern: Option<String>,
    }

    /// The source title of a pending grab covering the target.
    pub fn find_pending_covering(t: &Covering) -> R<Option<String>> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct T {
            source_title: String,
        }
        let row: Option<T> = first(
            r#"SELECT "sourceTitle" FROM "download_history"
          WHERE "mediaId" = $1 AND "status" IN ('grabbed', 'importing')
            AND (
              ("coverCompleteSeries" IS NOT NULL AND (
                 ("coverCompleteSeries" AND $2::int > 0)
                 OR ($2::int BETWEEN "coverSeasonFrom" AND "coverSeasonTo"
                     AND ("coverEpisodeFrom" IS NULL
                          OR ($3::int IS NOT NULL AND $2::int = "coverSeasonFrom"
                              AND $3::int BETWEEN "coverEpisodeFrom" AND "coverEpisodeTo")))
              ))
              OR ("coverCompleteSeries" IS NULL AND (
                 ("seasonId" = $4 AND "episodeId" IS NULL)
                 OR ($3::int IS NOT NULL AND "sourceTitle" ILIKE $5)
              ))
            )
          LIMIT 1"#,
            &[
                int(t.media_id),
                int(t.season_number),
                opt_int(t.episode_number),
                int(t.season_id),
                opt_text(t.episode_tag_pattern.as_deref()),
            ],
        )?;
        Ok(row.map(|r| r.source_title))
    }

    pub fn find_by_hashes(hashes: &[String]) -> R<Vec<HistoryRow>> {
        if hashes.is_empty() {
            return Ok(vec![]);
        }
        query(
            &format!(
                r#"SELECT {COLUMNS} FROM "download_history" WHERE LOWER("torrentHash") = ANY($1::text[])"#
            ),
            &[Param::TextList(
                hashes.iter().map(|h| h.to_lowercase()).collect(),
            )],
        )
    }

    pub fn linked_source_titles() -> R<Vec<String>> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct T {
            source_title: String,
        }
        let rows: Vec<T> = query(
            r#"SELECT DISTINCT "sourceTitle" FROM "download_history" WHERE "mediaId" IS NOT NULL AND "sourceTitle" <> ''"#,
            &[],
        )?;
        Ok(rows.into_iter().map(|r| r.source_title).collect())
    }

    pub fn by_statuses(statuses: &[&str]) -> R<Vec<HistoryRow>> {
        query(
            &format!(
                r#"SELECT {COLUMNS} FROM "download_history" WHERE "status" = ANY($1::text[])"#
            ),
            &[Param::TextList(
                statuses.iter().map(|s| (*s).into()).collect(),
            )],
        )
    }

    /// Newest first; page and count share one WHERE.
    pub fn page(
        limit: i64,
        offset: i64,
        q: Option<&str>,
        status: Option<&str>,
    ) -> R<(Vec<HistoryRow>, i64)> {
        let mut conds = vec![];
        let mut params = vec![];
        if let Some(q) = q {
            params.push(text(q));
            conds.push(format!(
                r#"strpos(lower("sourceTitle"), lower(${})) > 0"#,
                params.len()
            ));
        }
        if let Some(s) = status {
            params.push(text(s));
            conds.push(format!(r#""status" = ${}"#, params.len()));
        }
        let wh = if conds.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conds.join(" AND "))
        };
        let n = params.len();
        let count: Option<Count> = first(
            &format!(r#"SELECT COUNT(*)::int AS "count" FROM "download_history" {wh}"#),
            &params,
        )?;
        params.push(int(limit));
        params.push(int(offset));
        let rows = query(
            &format!(
                r#"SELECT {COLUMNS} FROM "download_history" {wh}
          ORDER BY "createdAt" DESC, "id" DESC LIMIT ${} OFFSET ${}"#,
                n + 1,
                n + 2
            ),
            &params,
        )?;
        Ok((rows, count.map_or(0, |c| c.count)))
    }

    pub fn completed_by_hashes(hashes: &[String]) -> R<Vec<HistoryRow>> {
        query(
            &format!(
                r#"SELECT {COLUMNS} FROM "download_history"
        WHERE "status" = 'completed' AND LOWER("torrentHash") = ANY($1::text[])"#
            ),
            &[Param::TextList(
                hashes.iter().map(|h| h.to_lowercase()).collect(),
            )],
        )
    }

    pub fn find(id: i64) -> R<Option<HistoryRow>> {
        first(
            &format!(r#"SELECT {COLUMNS} FROM "download_history" WHERE "id" = $1"#),
            &[int(id)],
        )
    }

    pub fn remove(id: i64) -> R<()> {
        exec(
            r#"DELETE FROM "download_history" WHERE "id" = $1"#,
            &[int(id)],
        )
        .map(drop)
    }

    pub fn clear_terminal() -> R<u64> {
        exec(
            r#"DELETE FROM "download_history" WHERE "status" IN ('completed', 'failed', 'import_failed', 'warning')"#,
            &[],
        )
    }

    pub fn latest_by_hash(hash: &str) -> R<Option<HistoryRow>> {
        first(
            &format!(
                r#"SELECT {COLUMNS} FROM "download_history" WHERE "torrentHash" = $1 ORDER BY "createdAt" DESC LIMIT 1"#
            ),
            &[text(hash)],
        )
    }

    pub fn insert_grab(g: &Grab) -> R<HistoryRow> {
        let sql = format!(
            r#"INSERT INTO "download_history"
         ("sourceTitle", "quality", "language", "torrentHash", "size", "infoUrl", "grabSource",
          "mediaId", "episodeId", "seasonId", "indexerId", "downloadClientId",
          "coverSeasonFrom", "coverSeasonTo", "coverEpisodeFrom", "coverEpisodeTo", "coverCompleteSeries")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING {COLUMNS}"#
        );
        let mut p = vec![
            text(&g.source_title),
            text(&g.quality),
            Param::Null,
            opt_text(g.torrent_hash.as_deref()),
            opt_int(g.size),
            opt_text(g.info_url.as_deref()),
            text(g.grab_source),
            int(g.media_id),
            opt_int(g.episode_id),
            opt_int(g.season_id),
            opt_int(g.indexer_id),
            opt_int(g.download_client_id),
        ];
        p.extend(cov(&g.coverage));
        first(&sql, &p)?.ok_or_else(|| {
            crate::error::Error::Other(r#"insert into "download_history" returned no row"#.into())
        })
    }

    /// The lease outlives the 30 min ingest, so a trapped job cannot strand the row.
    pub fn mark_importing(id: i64) -> R<()> {
        exec(
            r#"UPDATE "download_history" SET "status" = 'importing', "importLeaseUntil" = now() + interval '35 minutes', "updatedAt" = now() WHERE "id" = $1"#,
            &[int(id)],
        )
        .map(drop)
    }

    /// Re-arms `importing` rows whose lease ran out (a trapped job, or a restart).
    pub fn sweep_import_leases() -> R<u64> {
        exec(
            r#"UPDATE "download_history" SET "status" = 'grabbed', "importLeaseUntil" = NULL
         WHERE "status" = 'importing' AND ("importLeaseUntil" IS NULL OR "importLeaseUntil" < now())"#,
            &[],
        )
    }

    pub fn mark_failed(id: i64, message: &str) -> R<()> {
        exec(
            r#"UPDATE "download_history" SET "status" = 'failed', "statusMessage" = $2, "updatedAt" = now() WHERE "id" = $1"#,
            &[int(id), text(message)],
        )
        .map(drop)
    }

    pub fn set_status(ids: &[i64], status: &str, message: Option<&str>) -> R<()> {
        exec(
            r#"UPDATE "download_history" SET "status" = $2, "statusMessage" = $3, "updatedAt" = now() WHERE "id" = ANY($1::int[])"#,
            &[Param::IntList(ids.to_vec()), text(status), opt_text(message)],
        )
        .map(drop)
    }

    /// Re-arms a refused import; false when the row is gone or no longer `import_failed`.
    pub fn retry_import(id: i64) -> R<bool> {
        exec(
            r#"UPDATE "download_history" SET "status" = 'grabbed', "statusMessage" = NULL, "updatedAt" = now() WHERE "id" = $1 AND "status" = 'import_failed'"#,
            &[int(id)],
        )
        .map(|n| n > 0)
    }

    pub fn complete_import(id: i64) -> R<()> {
        exec(
            r#"UPDATE "download_history" SET "status" = 'completed', "updatedAt" = now() WHERE "id" = $1"#,
            &[int(id)],
        )
        .map(drop)
    }

    pub fn update_hash(id: i64, hash: &str) -> R<()> {
        exec(
            r#"UPDATE "download_history" SET "torrentHash" = $2, "updatedAt" = now() WHERE "id" = $1"#,
            &[int(id), text(hash)],
        )
        .map(drop)
    }

    /// Heals an orphan row; coverage fills only a row that has none.
    pub fn heal_match(
        id: i64,
        media_id: i64,
        episode_id: Option<i64>,
        season_id: Option<i64>,
        quality: &str,
        c: &Coverage,
    ) -> R<()> {
        let mut p = vec![
            int(id),
            int(media_id),
            opt_int(episode_id),
            opt_int(season_id),
            text(quality),
        ];
        p.extend(cov(c));
        exec(
            r#"UPDATE "download_history"
         SET "mediaId" = $2, "episodeId" = $3, "seasonId" = $4, "quality" = $5, "updatedAt" = now(),
             "coverSeasonFrom" = CASE WHEN "coverCompleteSeries" IS NULL THEN $6::int ELSE "coverSeasonFrom" END,
             "coverSeasonTo" = CASE WHEN "coverCompleteSeries" IS NULL THEN $7::int ELSE "coverSeasonTo" END,
             "coverEpisodeFrom" = CASE WHEN "coverCompleteSeries" IS NULL THEN $8::int ELSE "coverEpisodeFrom" END,
             "coverEpisodeTo" = CASE WHEN "coverCompleteSeries" IS NULL THEN $9::int ELSE "coverEpisodeTo" END,
             "coverCompleteSeries" = CASE WHEN "coverCompleteSeries" IS NULL THEN $10::boolean ELSE "coverCompleteSeries" END
       WHERE "id" = $1"#,
            &p,
        )
        .map(drop)
    }

    pub fn fill_coverage(id: i64, c: &Coverage) -> R<()> {
        if c.cover_complete_series.is_none() {
            return Ok(());
        }
        let mut p = vec![int(id)];
        p.extend(cov(c));
        exec(
            r#"UPDATE "download_history"
         SET "coverSeasonFrom" = $2, "coverSeasonTo" = $3, "coverEpisodeFrom" = $4, "coverEpisodeTo" = $5,
             "coverCompleteSeries" = $6
       WHERE "id" = $1 AND "coverCompleteSeries" IS NULL"#,
            &p,
        )
        .map(drop)
    }
}

/// Keyed JSON state the cron jobs carry between runs.
pub mod state {
    use super::*;

    pub fn get(key: &str) -> R<Option<Json>> {
        #[derive(Deserialize)]
        struct V {
            value: Json,
        }
        Ok(first::<V>(
            r#"SELECT "value" FROM "poller_state" WHERE "key" = $1"#,
            &[text(key)],
        )?
        .map(|v| v.value))
    }

    pub fn set(key: &str, value: &Json) -> R<()> {
        exec(
            r#"INSERT INTO "poller_state" ("key", "value") VALUES ($1, $2)
         ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()"#,
            &[text(key), Param::Json(value.to_string())],
        )
        .map(drop)
    }

    pub fn delete(key: &str) -> R<()> {
        exec(
            r#"DELETE FROM "poller_state" WHERE "key" = $1"#,
            &[text(key)],
        )
        .map(drop)
    }
}

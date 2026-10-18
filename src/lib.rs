//! `fliks.download` as a `fliks:plugin@2.0.0` component: indexer search, download clients and
//! the acquisition grab pipeline.

#[macro_use]
pub mod log;
pub mod config;
pub mod db;
pub mod error;
pub mod grab;
pub mod indexers;
pub mod net;
pub mod poller;
pub mod qbit;
pub mod routes;
pub mod sources;
pub mod throttle;
pub mod torznab;
pub mod util;

use fliks_plugin_sdk::{HealthReport, HttpRequest, HttpResponse, Plugin, host};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// What a job keeps back of its 60 min, and a scheduled call of its 5.
const JOB_MARGIN: Duration = Duration::from_secs(10 * 60);
const SCHEDULED_MARGIN: Duration = Duration::from_secs(60);

type Job = fn(Option<&str>) -> error::R<()>;

/// The handler of a manifest job.
pub fn job_handler(name: &str) -> Option<Job> {
    Some(match name {
        "SearchMissing" => search_missing_job,
        "RssSync" => |_| grab::rss_sync(JOB_MARGIN),
        "ImportCompleted" => |_| poller::poll(),
        "CleanStalled" => |_| poller::clean_stalled(),
        "CleanSeeded" => |_| poller::clean_seeded(),
        _ => return None,
    })
}

struct Download;

fn text(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn resume_of(v: &Value) -> Option<(Option<u32>, Option<u32>)> {
    let r = v.get("resume")?;
    let id = |k: &str| {
        r.get(k)
            .and_then(Value::as_u64)
            .and_then(|i| u32::try_from(i).ok())
    };
    Some((id("seasonId"), id("episodeId")))
}

/// `SearchMissing`: a scoped run starts from the top; the unscoped sweep resumes where the
/// last run ran out of time.
fn search_missing_job(args: Option<&str>) -> error::R<()> {
    let args: Value = args
        .and_then(|a| serde_json::from_str(a).ok())
        .unwrap_or(Value::Null);
    let ids = args
        .get("mediaIds")
        .and_then(Value::as_array)
        .filter(|a| a.iter().all(Value::is_number));
    if let Some(ids) = ids {
        let ids = ids
            .iter()
            .filter_map(Value::as_u64)
            .filter_map(|i| u32::try_from(i).ok())
            .collect();
        grab::search_missing(Some(ids), None, JOB_MARGIN)?;
        return Ok(());
    }
    let resume = db::state::get("searchMissingResume")?
        .and_then(|v| serde_json::from_value::<(u32, Option<u32>, Option<u32>)>(v).ok());
    match grab::search_missing(None, resume, JOB_MARGIN)? {
        Some(key) => db::state::set("searchMissingResume", &json!(key)),
        None => db::state::delete("searchMissingResume"),
    }
}

impl Plugin for Download {
    fn health() -> HealthReport {
        match fliks_plugin_sdk::db::query("SELECT 1 AS one", &[]) {
            Ok(_) => HealthReport {
                ok: true,
                detail: None,
            },
            Err(e) => HealthReport {
                ok: false,
                detail: Some(e.message),
            },
        }
    }

    fn start() -> Result<(), String> {
        let applied = fliks_plugin_sdk::db::migrate(&db::MIGRATIONS)
            .map_err(|e| format!("{}: {}", e.code, e.message))?;
        if !applied.is_empty() {
            info!("migrations applied: {}", applied.join(", "));
        }
        let swept = db::history::sweep_import_leases().map_err(text)?;
        if swept > 0 {
            warn!("Import: {swept} importing entries outlived their lease — re-armed as grabbed");
        }
        // Viewers may hold a snapshot from before the restart: the next tick states every set.
        db::state::set("progressResync", &json!(true)).map_err(text)
    }

    fn job(name: String, _job_id: String, args: Option<String>) -> Result<(), String> {
        let h = job_handler(&name)
            .ok_or_else(|| format!("no handler registered for job \"{name}\""))?;
        h(args.as_deref()).map_err(text)
    }

    fn scheduled(key: String, payload: String, _attempt: u32) -> Result<(), String> {
        let payload: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
        let (prefix, rest) = key.split_once(':').unwrap_or((&key, ""));
        let id: Option<u32> = rest.parse().ok();
        match (prefix, id) {
            ("search", Some(media)) => {
                let resume = resume_of(&payload).map(|(s, e)| (media, s, e));
                if let Some((_, s, e)) =
                    grab::search_missing(Some(vec![media]), resume, SCHEDULED_MARGIN)
                        .map_err(text)?
                {
                    fliks_plugin_sdk::scheduled::schedule(
                        &key,
                        0,
                        &json!({ "resume": { "seasonId": s, "episodeId": e } }),
                    )
                    .map_err(|e| e.message)?;
                }
                Ok(())
            }
            ("caps", Some(id)) => {
                let Some(mut ix) = db::indexers::find(id.into()).map_err(text)? else {
                    return Ok(());
                };
                let left = Duration::from_millis(host::deadline_remaining_ms())
                    .saturating_sub(SCHEDULED_MARGIN);
                let round = torznab::Round {
                    until: Instant::now() + left,
                    fetch_timeout: Duration::from_secs(10),
                };
                torznab::refresh_caps(&mut ix, round)
                    .map_err(|_| format!("[{}] caps probe: the slot stayed busy", ix.name))
            }
            ("grab-started", Some(_)) => {
                if let Err(e) = host::notifications_dispatch_grab_started(&payload.to_string()) {
                    warn!("AutoGrab: notifications.dispatch failed: {}", e.message);
                }
                Ok(())
            }
            _ => {
                warn!("scheduled call \"{key}\" has no handler, dropped");
                Ok(())
            }
        }
    }

    fn http(req: HttpRequest) -> Result<HttpResponse, String> {
        routes::ROUTER.handle(req)
    }

    /// `media.acquisition.requested` schedules one `search:<id>` per media: a second event for
    /// the same media replaces its pending call.
    fn event(name: String, payload: String) {
        if name != "media.acquisition.requested" {
            return;
        }
        let payload: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
        let mut ids: Vec<u32> = vec![];
        for v in payload
            .get("mediaIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(f) = v
                .as_f64()
                .filter(|f| f.fract() == 0.0 && *f > 0.0 && *f <= f64::from(u32::MAX))
            else {
                continue;
            };
            if !ids.contains(&(f as u32)) {
                ids.push(f as u32);
            }
        }
        if ids.is_empty() {
            return;
        }
        match config::immediate_search() {
            Err(e) => error!("{name}: search failed: {e}"),
            Ok(false) => {
                info!("{name}: immediate search is off, left to the next scheduled search")
            }
            Ok(true) => {
                let list: Vec<String> = ids.iter().map(u32::to_string).collect();
                info!("{name}: searching for media {}", list.join(", "));
                for id in ids {
                    if let Err(e) = fliks_plugin_sdk::scheduled::schedule(
                        &format!("search:{id}"),
                        0,
                        &json!({}),
                    ) {
                        error!("{name}: search of #{id} not scheduled: {}", e.message);
                    }
                }
            }
        }
    }

    fn config_changed(keys: Vec<String>) {
        info!("config changed: {} (read on next use)", keys.join(", "));
    }
}

fliks_plugin_sdk::export!(Download);

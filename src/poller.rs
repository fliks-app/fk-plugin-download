//! `ImportCompleted`, `CleanStalled`, `CleanSeeded` and the progress sets they publish.

use crate::config;
use crate::db::{
    DownloadClientRow, HistoryRow, blocklist, clients, history, indexers, stalled, state,
};
use crate::error::R;
use crate::grab::{coverage_columns, identify, season_episode_ids};
use crate::qbit::{self, Torrent};
use crate::util::{decode_html_entities, js_number, now_ms, parse_date_ms};
use fliks_plugin_sdk::bindings::fliks::plugin::types::{
    AcquisitionEvent, DownloadProgress, DownloadState, Failed, Imported, IngestRequest,
    ResolveQuery, StalledRemoved, TransferMode,
};
use fliks_plugin_sdk::host;
use regex::Regex;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const VIDEO_EXTS: [&str; 8] = [
    ".mkv", ".mp4", ".avi", ".mov", ".ts", ".m2ts", ".wmv", ".flv",
];
const ORPHAN_GRACE_MS: i64 = 5 * 60_000;
const ORPHAN_STATUS_MESSAGE: &str = "Torrent no longer present in download client";
const RESOLVE_BATCH: usize = 50;
/// Ingest takes up to 30 min: no new import starts with less left of the job's hour.
const IMPORT_MIN_LEFT: Duration = Duration::from_secs(32 * 60);

/// Log dedupe across ticks of a job instance; a re-created instance logs the line again.
static UNIDENTIFIED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static UNTRACKED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static STALL_SKIP: Mutex<Option<String>> = Mutex::new(None);

fn seen(set: &Mutex<Option<HashSet<String>>>, key: &str) -> bool {
    set.lock()
        .ok()
        .and_then(|s| s.as_ref().map(|s| s.contains(key)))
        .unwrap_or(false)
}

fn remember(set: &Mutex<Option<HashSet<String>>>, keys: HashSet<String>) {
    if let Ok(mut s) = set.lock() {
        *s = Some(keys);
    }
}

fn stall_skip(reason: Option<&str>) {
    let Ok(mut last) = STALL_SKIP.lock() else {
        return;
    };
    if let Some(r) = reason.filter(|r| last.as_deref() != Some(*r)) {
        info!("StalledCleanup: skipped, {r}");
    }
    *last = reason.map(str::to_owned);
}

pub struct Held {
    pub client_id: i64,
    pub t: Torrent,
}

/// Every enabled client's torrents, with whether all of them answered.
pub fn fetch_all() -> R<(Vec<Held>, bool)> {
    let mut out = vec![];
    let mut all_ok = true;
    for c in clients::list_enabled()?.into_iter().filter(qbit::supports) {
        let (ok, ts) = qbit::torrents(&c);
        all_ok &= ok;
        out.extend(ts.into_iter().map(|t| Held { client_id: c.id, t }));
    }
    Ok((out, all_ok))
}

// --- matching torrents to history rows -------------------------------------------------------

static NAME_SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[._\s]+").unwrap());
static DOT_TORRENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.torrent$").unwrap());

/// Entities decoded, `.torrent` dropped, separators collapsed, lowercased.
pub fn normalise_name(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let s = decode_html_entities(raw);
    let s = DOT_TORRENT.replace(&s, "");
    NAME_SEP.replace_all(&s, " ").trim().to_lowercase()
}

fn authority(h: &HistoryRow) -> i32 {
    (if h.media_id.is_some_and(|m| m != 0) {
        2
    } else {
        0
    }) + i32::from(h.is_live())
}

pub fn outranks(candidate: &HistoryRow, current: &HistoryRow) -> bool {
    let d = authority(candidate) - authority(current);
    d > 0 || (d == 0 && candidate.id > current.id)
}

fn best<'a>(rows: impl Iterator<Item = &'a HistoryRow>) -> Option<&'a HistoryRow> {
    rows.fold(None, |b: Option<&HistoryRow>, h| match b {
        Some(b) if !outranks(h, b) => Some(b),
        _ => Some(h),
    })
}

/// Hash, then exact normalised name, then a unique prefix overlap; several prefixes abort.
pub fn find_match<'a>(
    hash: &str,
    name: &str,
    rows: &'a [HistoryRow],
) -> Option<(&'a HistoryRow, bool)> {
    let hash = hash.to_lowercase();
    if !hash.is_empty()
        && let Some(h) = best(rows.iter().filter(|h| {
            h.torrent_hash
                .as_ref()
                .is_some_and(|t| t.to_lowercase() == hash)
        }))
    {
        return Some((h, true));
    }
    let name = normalise_name(name);
    let titles: Vec<String> = rows
        .iter()
        .map(|h| normalise_name(&h.source_title))
        .collect();
    if let Some(h) = best(
        rows.iter()
            .zip(&titles)
            .filter(|(_, t)| **t == name)
            .map(|(h, _)| h),
    ) {
        return Some((h, false));
    }
    let prefix: Vec<&HistoryRow> = rows
        .iter()
        .zip(&titles)
        .filter(|(_, t)| !t.is_empty() && (name.starts_with(t.as_str()) || t.starts_with(&name)))
        .map(|(h, _)| h)
        .collect();
    match prefix.len() {
        1 => Some((prefix[0], false)),
        0 => None,
        n => {
            warn!(
                "TorrentHistoryMatcher: {n} histories with prefix overlap on \"{name}\" — skipped"
            );
            None
        }
    }
}

/// Match, and persist the hash on a row matched by name.
fn match_and_heal(t: &Torrent, rows: &mut [HistoryRow]) -> R<Option<HistoryRow>> {
    let Some((h, by_hash)) = find_match(&t.hash, &t.name, rows) else {
        return Ok(None);
    };
    let id = h.id;
    let row = rows
        .iter_mut()
        .find(|r| r.id == id)
        .expect("the matched row");
    if !by_hash && !t.hash.is_empty() && row.torrent_hash.as_deref().is_none_or(str::is_empty) {
        history::update_hash(id, &t.hash.to_lowercase())?;
        row.torrent_hash = Some(t.hash.to_lowercase());
    }
    Ok(Some(row.clone()))
}

// --- progress ------------------------------------------------------------------------------

fn download_state(s: &str) -> DownloadState {
    match s {
        "queued" => DownloadState::Queued,
        "stalled" => DownloadState::Stalled,
        "paused" => DownloadState::Paused,
        "importing" => DownloadState::Importing,
        _ => DownloadState::Active,
    }
}

/// Season/episode numbers behind each row's ids, batched within `media.resolve`'s bound.
fn scope_numbers(rows: &[&HistoryRow]) -> HashMap<i64, (Option<u32>, Option<u32>)> {
    let mut out = HashMap::new();
    let seasons: Vec<u32> = dedup(
        rows.iter()
            .filter(|r| r.episode_id.is_none())
            .filter_map(|r| r.season_id)
            .map(|i| i as u32),
    );
    let episodes: Vec<u32> = dedup(rows.iter().filter_map(|r| r.episode_id).map(|i| i as u32));
    let mut i = 0;
    while i < seasons.len().max(episodes.len()) {
        let q = ResolveQuery {
            media_ids: vec![],
            season_ids: seasons
                .iter()
                .skip(i)
                .take(RESOLVE_BATCH)
                .copied()
                .collect(),
            episode_ids: episodes
                .iter()
                .skip(i)
                .take(RESOLVE_BATCH)
                .copied()
                .collect(),
        };
        i += RESOLVE_BATCH;
        let resolved: HashMap<String, _> = match host::media_resolve(&q) {
            Ok(r) => r.into_iter().collect(),
            Err(e) => {
                warn!("Import: scope resolve failed: {}", e.message);
                continue;
            }
        };
        for r in rows {
            let key = match (r.episode_id, r.season_id) {
                (Some(e), _) => format!("episode:{e}"),
                (None, Some(s)) => format!("season:{s}"),
                _ => continue,
            };
            if let Some(hit) = resolved.get(&key) {
                out.insert(r.id, (hit.season_number, hit.episode_number));
            }
        }
    }
    out
}

fn dedup(it: impl Iterator<Item = u32>) -> Vec<u32> {
    let mut seen = HashSet::new();
    it.filter(|x| seen.insert(*x)).collect()
}

/// Each media's downloads, the media in first-seen order, and the in-flight rows.
struct Sets {
    by_media: HashMap<i64, Vec<DownloadProgress>>,
    order: Vec<i64>,
    rows: Vec<HistoryRow>,
}

fn build_sets(all: &[Held]) -> R<Sets> {
    let mut rows = history::by_statuses(&["grabbed", "importing"])?;
    let importing: HashSet<String> = rows
        .iter()
        .filter(|r| r.status == "importing")
        .filter_map(|r| r.torrent_hash.as_ref())
        .map(|h| h.to_lowercase())
        .collect();
    let mut matched: Vec<(&Torrent, HistoryRow)> = vec![];
    for h in all
        .iter()
        .filter(|h| h.t.progress < 1.0 || importing.contains(&h.t.hash.to_lowercase()))
    {
        if let Some(row) = match_and_heal(&h.t, &mut rows)?
            && row.media_id.is_some_and(|m| m != 0)
        {
            matched.push((&h.t, row));
        }
    }
    let scopes = scope_numbers(&matched.iter().map(|(_, r)| r).collect::<Vec<_>>());
    let mut by_media: HashMap<i64, Vec<DownloadProgress>> = HashMap::new();
    let mut order = vec![];
    for (t, row) in &matched {
        let media = row.media_id.unwrap_or_default();
        let (sn, en) = scopes.get(&row.id).copied().unwrap_or_default();
        let state = if row.status == "importing" {
            "importing"
        } else {
            qbit::progress_state(&t.state)
        };
        if !by_media.contains_key(&media) {
            order.push(media);
        }
        by_media.entry(media).or_default().push(DownloadProgress {
            ref_: t.hash.clone(),
            season_number: sn,
            episode_number: en,
            progress: t.progress,
            bytes_per_second: Some(t.dlspeed),
            eta_seconds: (t.eta > 0.0 && t.eta < 8_640_000.0).then_some(t.eta),
            state: download_state(state),
        });
    }
    Ok(Sets {
        by_media,
        order,
        rows,
    })
}

fn publish_set(media: i64, downloads: &[DownloadProgress]) {
    if let Err(e) = host::progress_set(media as u32, downloads) {
        warn!("Import: progress publish failed: {}", e.message);
    }
}

fn publish_one(media: i64, all: &[Held], all_ok: bool) -> R<()> {
    if !all_ok {
        return Ok(());
    }
    let by_media = build_sets(all)?.by_media;
    publish_set(media, by_media.get(&media).map_or(&[][..], Vec::as_slice));
    Ok(())
}

/// Every media's complete set; one that had downloads last tick and has none is stated empty.
/// After a start the rows stand in for that memory (`progressResync`).
fn emit_progress(all: &[Held], all_ok: bool) -> R<()> {
    if !all_ok {
        return Ok(());
    }
    let Sets {
        mut by_media,
        mut order,
        rows,
    } = build_sets(all)?;
    let resync = state::get("progressResync")?.is_some_and(|v| v == json!(true));
    let owed: Vec<i64> = if resync {
        rows.iter().filter_map(|r| r.media_id).collect()
    } else {
        state::get("reportedMediaIds")?
            .and_then(|v| serde_json::from_value::<Vec<i64>>(v).ok())
            .unwrap_or_default()
    };
    for m in owed {
        if let std::collections::hash_map::Entry::Vacant(e) = by_media.entry(m) {
            e.insert(vec![]);
            order.push(m);
        }
    }
    let reported: Vec<i64> = order
        .iter()
        .copied()
        .filter(|m| by_media.get(m).is_some_and(|l| !l.is_empty()))
        .collect();
    state::set("reportedMediaIds", &json!(reported))?;
    if resync {
        state::set("progressResync", &json!(false))?;
    }
    for m in order {
        publish_set(m, &by_media[&m]);
    }
    Ok(())
}

pub type Outcome = &'static str;

fn reached(all: &[Held], hash: &str, expect: Outcome) -> bool {
    let Some(h) = all.iter().find(|h| h.t.hash.eq_ignore_ascii_case(hash)) else {
        return true;
    };
    if expect == "absent" {
        return false;
    }
    let paused = qbit::progress_state(&h.t.state) == "paused";
    if expect == "paused" { paused } else { !paused }
}

/// Waits (up to 4 s) for the client to reflect a control, then states that media's set.
pub fn settle_and_publish(row: &HistoryRow, expect: Outcome) -> R<()> {
    let (Some(media), Some(hash)) = (row.media_id, row.torrent_hash.as_deref()) else {
        return Ok(());
    };
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let (all, ok) = fetch_all()?;
        if reached(&all, hash, expect) || Instant::now() >= deadline {
            return publish_one(media, &all, ok);
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

// --- ImportCompleted ---------------------------------------------------------------------------

fn publish(ev: AcquisitionEvent, what: &str, title: &str) {
    if let Err(e) = host::events_publish(&[ev]) {
        warn!("Import[{title}]: failed to publish {what}: {}", e.message);
    }
}

fn publish_failed(h: &HistoryRow, reason: &str) {
    if let Some(m) = h.media_id {
        let ev = AcquisitionEvent::Failed(Failed {
            media_id: m as u32,
            title: h.source_title.clone(),
            reason: reason.into(),
        });
        publish(ev, "acquisition.failed", &h.source_title);
    }
}

fn publish_queue_changed(context: &str) {
    if let Err(e) = host::events_publish(&[AcquisitionEvent::QueueChanged]) {
        warn!("{context}: queue-changed publish failed: {}", e.message);
    }
}

pub fn poll() -> R<()> {
    let swept = history::sweep_import_leases()?;
    if swept > 0 {
        warn!("Import: {swept} importing entries outlived their lease — re-armed as grabbed");
    }
    let enabled: Vec<DownloadClientRow> = clients::list_enabled()?
        .into_iter()
        .filter(qbit::supports)
        .collect();
    if enabled.is_empty() {
        warn!("Import: no enabled download client found");
        return Ok(());
    }
    let (all, all_ok) = fetch_all()?;
    auto_match(&all)?;
    let mut grabbed = history::by_statuses(&["grabbed", "failed", "import_failed", "warning"])?;
    let importing = history::by_statuses(&["importing"])?;
    if all_ok {
        reconcile(&all, &grabbed, &importing)?;
    }
    emit_progress(&all, all_ok)?;

    let completed: Vec<&Held> = all
        .iter()
        .filter(|h| {
            h.t.progress >= 1.0
                || ["seeding", "stalledUP", "stoppedUP"].contains(&h.t.state.as_str())
        })
        .collect();
    if completed.is_empty() {
        return Ok(());
    }
    let mut imported = 0;
    for held in &completed {
        let Some(row) = match_and_heal(&held.t, &mut grabbed)? else {
            continue;
        };
        // A failed row is re-armed only by the orphan sweep or a manual retry.
        if row.status != "grabbed" && row.status != "warning" {
            continue;
        }
        if Duration::from_millis(host::deadline_remaining_ms()) < IMPORT_MIN_LEFT {
            info!(
                "Import: too little of the job left to start another ingest, the next tick continues"
            );
            break;
        }
        info!(
            "Import: torrent \"{}\" -> history #{} (mediaId={:?}, status={})",
            held.t.name, row.id, row.media_id, row.status
        );
        let Some(client) = enabled.iter().find(|c| c.id == held.client_id) else {
            let message = "download client for this torrent is no longer enabled";
            warn!("Import: \"{}\" — {message}; will retry", row.source_title);
            history::set_status(&[row.id], "grabbed", Some(message))?;
            continue;
        };
        let run = || {
            history::mark_importing(row.id)?;
            if let Some(m) = row.media_id {
                publish_one(m, &all, all_ok)?;
            }
            process_one(&row, &held.t, client)
        };
        match run() {
            Ok(()) => imported += 1,
            Err(e) if e.is_unknown_outcome() => {
                warn!(
                    "Import: \"{}\" — core did not confirm ({e}); will retry",
                    row.source_title
                );
                history::set_status(&[row.id], "grabbed", Some(&e.to_string()))?;
            }
            Err(e) => {
                // Core's own state (a full disk, a missing root), never a verdict on the release.
                error!("Import: FAILED for \"{}\": {e}", row.source_title);
                history::set_status(&[row.id], "import_failed", Some(&e.to_string()))?;
                publish_failed(&row, &e.to_string());
            }
        }
    }
    if imported > 0 {
        info!(
            "Import: processed {imported}/{} completed torrent(s)",
            completed.len()
        );
    }
    Ok(())
}

/// Binds torrents no row claims to the media `releases.match` names.
fn auto_match(all: &[Held]) -> R<()> {
    if all.is_empty() {
        return Ok(());
    }
    let hashes: Vec<String> = all
        .iter()
        .map(|h| h.t.hash.clone())
        .filter(|h| !h.is_empty())
        .collect();
    let mut by_hash: HashMap<String, HistoryRow> = HashMap::new();
    for h in history::find_by_hashes(&hashes)? {
        let Some(key) = h.torrent_hash.as_ref().map(|t| t.to_lowercase()) else {
            continue;
        };
        if by_hash.get(&key).is_none_or(|kept| outranks(&h, kept)) {
            by_hash.insert(key, h);
        }
    }
    let candidates: Vec<&Held> = all
        .iter()
        .filter(|h| !h.t.hash.is_empty())
        .filter(|h| {
            by_hash
                .get(&h.t.hash.to_lowercase())
                .is_none_or(|r| r.media_id.is_none_or(|m| m == 0))
        })
        .collect();
    if candidates.is_empty() {
        remember(&UNIDENTIFIED, HashSet::new());
        return Ok(());
    }
    let linked: HashSet<String> = history::linked_source_titles()?
        .iter()
        .map(|t| normalise_name(t))
        .collect();
    let to_identify: Vec<&Held> = candidates
        .into_iter()
        .filter(|h| !linked.contains(&normalise_name(&h.t.name)))
        .collect();
    if to_identify.is_empty() {
        return Ok(());
    }
    let matches = identify(
        &to_identify
            .iter()
            .map(|h| h.t.name.clone())
            .collect::<Vec<_>>(),
    )?;
    let (mut bound, mut rebound) = (0, 0);
    let mut still = HashSet::new();
    for held in to_identify {
        let hash = held.t.hash.to_lowercase();
        let Some(Some(m)) = matches.get(&held.t.name) else {
            if !seen(&UNIDENTIFIED, &hash) {
                info!(
                    "Auto-match: \"{}\" — releases.match found no media for it",
                    held.t.name
                );
            }
            still.insert(hash);
            continue;
        };
        let (season_id, episode_id) =
            season_episode_ids(m.media_id, m.season_number, m.episode_number)?;
        let cov = coverage_columns(m.coverage.as_ref());
        match by_hash.get(&hash) {
            Some(row) => {
                history::heal_match(
                    row.id,
                    m.media_id.into(),
                    episode_id,
                    season_id,
                    &row.quality,
                    &cov,
                )?;
                rebound += 1;
            }
            None => {
                history::insert_grab(&history::Grab {
                    source_title: decode_html_entities(&held.t.name),
                    quality: "unknown".into(),
                    torrent_hash: Some(held.t.hash.clone()).filter(|h| !h.is_empty()),
                    size: Some(held.t.size).filter(|s| *s != 0),
                    info_url: None,
                    grab_source: "manual",
                    media_id: m.media_id.into(),
                    episode_id,
                    season_id,
                    indexer_id: None,
                    download_client_id: Some(held.client_id),
                    coverage: cov,
                })?;
                bound += 1;
            }
        }
    }
    remember(&UNIDENTIFIED, still);
    if bound + rebound > 0 {
        info!("Auto-match: done — {bound} created, {rebound} healed");
    }
    Ok(())
}

fn reconcile(all: &[Held], grabbed: &[HistoryRow], importing: &[HistoryRow]) -> R<()> {
    if grabbed.is_empty() && importing.is_empty() {
        return Ok(());
    }
    let candidates: Vec<HistoryRow> = grabbed.iter().chain(importing).cloned().collect();
    let mut torrent_of: HashMap<i64, &Torrent> = HashMap::new();
    for h in all {
        if let Some((row, _)) = find_match(&h.t.hash, &h.t.name, &candidates) {
            torrent_of.insert(row.id, &h.t);
        }
    }
    let mut changed = false;
    let restarted: Vec<i64> = importing
        .iter()
        .filter(|h| torrent_of.get(&h.id).is_some_and(|t| t.progress < 1.0))
        .map(|h| h.id)
        .collect();
    if !restarted.is_empty() {
        history::set_status(&restarted, "grabbed", None)?;
        changed = true;
        warn!(
            "Import: {} importing entries whose torrent is no longer complete — re-armed as grabbed",
            restarted.len()
        );
    }
    let revived: Vec<i64> = grabbed
        .iter()
        .filter(|h| {
            h.status == "failed"
                && h.status_message.as_deref() == Some(ORPHAN_STATUS_MESSAGE)
                && torrent_of.contains_key(&h.id)
        })
        .map(|h| h.id)
        .collect();
    if !revived.is_empty() {
        history::set_status(&revived, "grabbed", None)?;
        changed = true;
        info!(
            "Import: {} entries reappeared in the download client — cleared the orphan stamp",
            revived.len()
        );
    }
    let cutoff = now_ms() - ORPHAN_GRACE_MS;
    let expired: Vec<i64> = candidates
        .iter()
        .filter(|h| ["grabbed", "importing", "import_failed"].contains(&h.status.as_str()))
        .filter(|h| {
            !torrent_of.contains_key(&h.id)
                && parse_date_ms(&h.updated_at).is_some_and(|u| u < cutoff)
        })
        .map(|h| h.id)
        .collect();
    if !expired.is_empty() {
        history::set_status(&expired, "failed", Some(ORPHAN_STATUS_MESSAGE))?;
        changed = true;
        warn!(
            "Import: {} grabbed/importing entries lost their torrent for > 5min — marked failed",
            expired.len()
        );
    }
    if changed {
        publish_queue_changed("Import");
    }
    Ok(())
}

/// `path.join` with the separator of `save_path` (a drive letter or `\` means Windows).
pub fn join_path(save_path: &str, name: &str) -> String {
    let windows = save_path.contains('\\') || save_path.as_bytes().get(1) == Some(&b':');
    let sep = if windows { '\\' } else { '/' };
    let name = if windows {
        name.replace('/', "\\")
    } else {
        name.to_owned()
    };
    if save_path.is_empty() {
        return name;
    }
    format!(
        "{}{sep}{}",
        save_path.trim_end_matches(sep),
        name.trim_start_matches(sep)
    )
}

fn ext_of(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rfind('.') {
        Some(i) if i > 0 => base[i..].to_lowercase(),
        _ => String::new(),
    }
}

fn auto_blocklist(h: &HistoryRow, note: &str) {
    let name = h
        .indexer_id
        .and_then(|id| indexers::find(id).ok().flatten())
        .map(|ix| ix.name);
    let _ = blocklist::insert(&blocklist::Entry {
        source_title: &h.source_title,
        quality: Some(&h.quality),
        media_id: h.media_id,
        indexer_id: h.indexer_id,
        indexer_name: name.as_deref(),
        note: Some(note),
    });
}

fn process_one(h: &HistoryRow, t: &Torrent, client: &DownloadClientRow) -> R<()> {
    let Some(files) = qbit::files(client, &t.hash) else {
        let message = format!("could not list files for \"{}\"", t.name);
        warn!("Import[{}]: {message}; will retry", h.source_title);
        return history::set_status(&[h.id], "grabbed", Some(&message));
    };
    let save = t.save_path.clone().unwrap_or_default();
    let videos: Vec<String> = files
        .iter()
        .filter(|f| f.progress >= 1.0 && VIDEO_EXTS.contains(&ext_of(&f.name).as_str()))
        .map(|f| join_path(&save, &f.name))
        .collect();
    if videos.is_empty() {
        let msg = format!(
            "Import failed: no valid video file in the download \"{}\"",
            t.name
        );
        warn!("Import[{}]: {msg}", h.source_title);
        history::mark_failed(h.id, &msg)?;
        auto_blocklist(h, "Auto-blocklist: no valid video file in the download");
        if let Err(e) = qbit::delete(client, &t.hash, true) {
            warn!(
                "Import[{}]: failed to remove dud torrent: {e}",
                h.source_title
            );
        }
        publish_failed(h, &msg);
        return Ok(());
    }
    let Some(media) = h.media_id else {
        return history::set_status(
            &[h.id],
            "import_failed",
            Some("Import failed: no media linked to this download"),
        );
    };
    let result = host::library_ingest(&IngestRequest {
        idempotency_key: format!("download-history:{}", h.id),
        media_id: media as u32,
        paths: videos,
        transfer: TransferMode::Copy,
        fallback_quality: None,
        source_label: h.source_title.clone(),
    })?;
    let imported = |r: &fliks_plugin_sdk::bindings::fliks::plugin::types::IngestResult| {
        let ev = AcquisitionEvent::Imported(Imported {
            media_id: media as u32,
            season_number: r.season_number,
            episode_number: r.episode_number,
            quality: h.quality.clone(),
            source_title: h.source_title.clone(),
        });
        publish(ev, "acquisition.imported", &h.source_title);
    };
    if result.imported.is_empty() && !result.already_present.is_empty() {
        info!(
            "Import[{}]: already in the library — completing the row",
            h.source_title
        );
        history::complete_import(h.id)?;
        imported(&result);
        return Ok(());
    }
    if result.imported.is_empty() {
        let msg = format!(
            "Import failed: no file could be placed under the library root for \"{}\"",
            t.name
        );
        error!("Import[{}]: {msg}", h.source_title);
        history::set_status(&[h.id], "import_failed", Some(&msg))?;
        publish_failed(h, &msg);
        return Ok(());
    }
    history::complete_import(h.id)?;
    info!(
        "Import[{}]: completed successfully ({} file(s))",
        h.source_title,
        result.imported.len()
    );
    imported(&result);
    Ok(())
}

// --- CleanStalled ------------------------------------------------------------------------------

/// Removes stalled downloads; their re-search goes to `search:<mediaId>` calls.
pub fn clean_stalled() -> R<()> {
    let Some(cfg) = config::stall().map_err(crate::error::Error::Other)? else {
        stall_skip(Some("off, the number of checks before cleanup is not set"));
        return Ok(());
    };
    let window = (cfg.samples + 1) as f64 * cfg.interval_minutes as f64 * 60.0;
    stalled::prune_older_than_secs(window.max(86_400.0))?;
    let enabled: Vec<DownloadClientRow> = clients::list_enabled()?
        .into_iter()
        .filter(qbit::supports)
        .collect();
    if enabled.is_empty() {
        stall_skip(Some("no enabled download client supports it"));
        return Ok(());
    }
    stall_skip(None);
    let mut untracked = HashSet::new();
    let mut rows = history::by_statuses(&["grabbed", "failed", "warning", "importing"])?;
    let mut research: Vec<i64> = vec![];
    let now = now_ms();
    for client in &enabled {
        let (ok, torrents) = qbit::torrents(client);
        if !ok {
            continue;
        }
        for t in torrents.iter().filter(|t| {
            t.progress < 1.0
                && !t.hash.is_empty()
                && qbit::STALL_ELIGIBLE.contains(&t.state.as_str())
        }) {
            let Some(row) = match_and_heal(t, &mut rows)? else {
                if !seen(&UNTRACKED, &t.hash) {
                    info!(
                        "StalledCleanup: \"{}\" is not a download this plugin grabbed, ignored",
                        t.name
                    );
                }
                untracked.insert(t.hash.clone());
                continue;
            };
            if !is_stalled(t, &cfg, now)? {
                continue;
            }
            warn!(
                "StalledCleanup: \"{}\" stalled (under {} KiB/s for {} checks, interval={}m)",
                t.name,
                cfg.min_bytes_per_second / 1024.0,
                cfg.samples,
                cfg.interval_minutes
            );
            if let Err(e) = qbit::delete(client, &t.hash, true) {
                error!("StalledCleanup: failed to delete \"{}\": {e}", t.name);
                continue;
            }
            stalled::delete_by_hash(&t.hash)?;
            auto_blocklist(&row, "Auto-blocklist: stalled torrent");
            history::mark_failed(row.id, "Stalled — removed by stalled-download cleanup")?;
            let ev = AcquisitionEvent::StalledRemoved(StalledRemoved {
                media_id: row.media_id.map(|m| m as u32),
                title: row.source_title.clone(),
            });
            if let Err(e) = host::events_publish(&[ev]) {
                warn!(
                    "StalledCleanup: failed to publish acquisition.stalled.removed: {}",
                    e.message
                );
            }
            let restart =
                cfg.auto_restart && (row.grab_source == "auto" || cfg.include_manual_grabs);
            if let (true, Some(m)) = (restart, row.media_id)
                && !research.contains(&m)
            {
                research.push(m);
            }
        }
    }
    remember(&UNTRACKED, untracked);
    if !research.is_empty() {
        info!(
            "StalledCleanup: searching for a replacement for {} media(s)",
            research.len()
        );
        for m in research {
            if let Err(e) =
                fliks_plugin_sdk::scheduled::schedule(&format!("search:{m}"), 0, &json!({}))
            {
                warn!(
                    "StalledCleanup: re-search of #{m} not scheduled: {}",
                    e.message
                );
            }
        }
    }
    Ok(())
}

fn is_stalled(t: &Torrent, cfg: &config::Stall, now: i64) -> R<bool> {
    let latest = stalled::recent(&t.hash, 1)?;
    let due = latest
        .first()
        .and_then(|l| parse_date_ms(&l.checked_at))
        .is_none_or(|at| now - at >= cfg.interval_minutes * 60_000);
    if due {
        stalled::insert(&t.hash, t.downloaded)?;
    }
    let recent = stalled::recent(&t.hash, cfg.samples)?;
    if (recent.len() as i64) < cfg.samples {
        return Ok(false);
    }
    let samples: Vec<(i64, i64)> = recent
        .iter()
        .map(|r| {
            (
                r.downloaded_bytes,
                parse_date_ms(&r.checked_at).unwrap_or(0),
            )
        })
        .collect();
    Ok(qbit::stalled_strikes(&samples, cfg.min_bytes_per_second) >= cfg.samples)
}

// --- CleanSeeded -------------------------------------------------------------------------------

/// Empty keeps seeding; an unknown completion time is judged on ratio alone.
pub fn seed_reason(t: &Torrent, settings: &crate::util::Settings, now_s: f64) -> String {
    let retention = settings
        .get("maxRetentionDays")
        .filter(|v| !v.is_null())
        .map(|v| js_number(Some(v)));
    let done = t.completion_on.unwrap_or(0.0);
    if let Some(days) = retention.filter(|d| *d > 0.0)
        && done > 0.0
    {
        let age = (now_s - done) / 86_400.0;
        if age >= days {
            return format!("retention {}d >= {}d", age.round(), fmt_js(days));
        }
    }
    let target = settings
        .get("seedRatio")
        .filter(|v| !v.is_null())
        .map_or(1.0, |v| js_number(Some(v)));
    if t.ratio >= target {
        return format!("ratio {:.2} >= {}", t.ratio, fmt_js(target));
    }
    String::new()
}

fn fmt_js(f: f64) -> String {
    match crate::util::num(f) {
        Value::Number(n) => n.to_string(),
        _ => f.to_string(),
    }
}

pub fn clean_seeded() -> R<()> {
    let enabled: Vec<DownloadClientRow> = clients::list_enabled()?
        .into_iter()
        .filter(qbit::supports)
        .collect();
    if enabled.is_empty() {
        return Ok(());
    }
    let mut held: Vec<(&DownloadClientRow, Torrent)> = vec![];
    for c in &enabled {
        let (ok, ts) = qbit::torrents(c);
        if ok {
            held.extend(ts.into_iter().map(|t| (c, t)));
        }
    }
    if held.is_empty() {
        return Ok(());
    }
    let hashes: Vec<String> = held.iter().map(|(_, t)| t.hash.to_lowercase()).collect();
    let completed = history::completed_by_hashes(&hashes)?;
    if completed.is_empty() {
        return Ok(());
    }
    let all = indexers::list_all()?;
    let now_s = now_ms() as f64 / 1000.0;
    let mut deleted = false;
    for row in &completed {
        let Some(hash) = row.torrent_hash.as_ref().map(|h| h.to_lowercase()) else {
            continue;
        };
        let Some((client, t)) = held
            .iter()
            .rev()
            .find(|(_, t)| t.hash.to_lowercase() == hash)
        else {
            continue;
        };
        let settings = row
            .indexer_id
            .filter(|i| *i != 0)
            .and_then(|id| all.iter().find(|ix| ix.id == id))
            .map(|ix| ix.settings.clone())
            .unwrap_or_default();
        let reason = seed_reason(t, &settings, now_s);
        if reason.is_empty() {
            continue;
        }
        info!("SeedCleanup: removing \"{}\" ({reason})", t.name);
        match qbit::delete(client, &t.hash, true) {
            Ok(()) => deleted = true,
            Err(e) => error!("SeedCleanup: failed to delete \"{}\": {e}", t.name),
        }
    }
    if deleted {
        host::events_publish(&[AcquisitionEvent::QueueChanged])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_paths_with_the_save_path_flavour() {
        assert_eq!(join_path("/downloads/", "a/b.mkv"), "/downloads/a/b.mkv");
        assert_eq!(join_path("D:\\dl", "a/b.mkv"), "D:\\dl\\a\\b.mkv");
        assert_eq!(join_path("", "b.mkv"), "b.mkv");
        assert_eq!(ext_of("dir/Show.S01E01.MKV"), ".mkv");
        assert_eq!(ext_of(".hidden"), "");
    }

    #[test]
    fn seeding_rules() {
        let t = Torrent {
            ratio: 1.5,
            completion_on: Some(1_000.0),
            ..Default::default()
        };
        let s = |v: Value| v.as_object().unwrap().clone();
        assert_eq!(seed_reason(&t, &s(json!({})), 2_000.0), "ratio 1.50 >= 1");
        assert_eq!(seed_reason(&t, &s(json!({ "seedRatio": 2 })), 2_000.0), "");
        assert_eq!(
            seed_reason(
                &t,
                &s(json!({ "seedRatio": 2, "maxRetentionDays": 1 })),
                1_000.0 + 86_400.0 * 2.0
            ),
            "retention 2d >= 1d"
        );
        let unknown = Torrent {
            completion_on: None,
            ratio: 0.1,
            ..Default::default()
        };
        assert_eq!(
            seed_reason(&unknown, &s(json!({ "maxRetentionDays": 1 })), 1e12),
            ""
        );
    }
}

//! `plugin.fliks.download.<key>`, read per use (the plugin ignores `config-changed`).

use crate::util::{parse_float, parse_int};
use fliks_plugin_sdk::host;

fn get(keys: &[&str]) -> Vec<(String, String)> {
    host::config_get(Some(
        &keys.iter().map(|k| (*k).to_owned()).collect::<Vec<_>>(),
    ))
    .unwrap_or_default()
}

fn value(kv: &[(String, String)], key: &str) -> Option<String> {
    kv.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

/// Only the string `true` pauses the automatic sweeps.
pub fn auto_acquisition_paused(job: &str) -> bool {
    let paused = value(
        &get(&["auto_acquisition_paused"]),
        "auto_acquisition_paused",
    )
    .as_deref()
        == Some("true");
    if paused {
        info!("{job}: automatic acquisition is paused, skipped");
    }
    paused
}

/// Only the string `false` turns the immediate search off.
pub fn immediate_search() -> Result<bool, String> {
    let kv = host::config_get(Some(&["requestsAutoGrabOnApproval".to_owned()]))
        .map_err(|e| e.message)?;
    Ok(value(&kv, "requestsAutoGrabOnApproval").as_deref() != Some("false"))
}

pub const DEFAULT_SEARCH_BUDGET_MS: u64 = 30_000;

pub fn search_budget_ms_of(raw: Option<&str>) -> u64 {
    match raw.and_then(parse_int) {
        Some(s) => s.saturating_mul(1000).clamp(5_000, 120_000) as u64,
        None => DEFAULT_SEARCH_BUDGET_MS,
    }
}

/// `search_budget_seconds`, clamped to 5..120 s; a failed read falls back to 30 s.
pub fn search_budget_ms() -> u64 {
    search_budget_ms_of(value(&get(&["search_budget_seconds"]), "search_budget_seconds").as_deref())
}

pub struct Stall {
    pub samples: i64,
    pub interval_minutes: i64,
    pub auto_restart: bool,
    pub include_manual_grabs: bool,
    pub min_bytes_per_second: f64,
}

/// `None` keeps the cleanup off: an unset sample count must never start deleting torrents.
pub fn stall_of(kv: &[(String, String)]) -> Option<Stall> {
    let samples = value(kv, "stall_samples")
        .as_deref()
        .and_then(parse_int)
        .filter(|s| *s >= 2)?;
    let interval = value(kv, "stall_interval_minutes")
        .as_deref()
        .and_then(parse_int)
        .filter(|i| *i > 0)
        .unwrap_or(60);
    let speed = value(kv, "stall_min_speed_kib").map_or(f64::NAN, |v| parse_float(&v));
    Some(Stall {
        samples,
        interval_minutes: interval,
        auto_restart: value(kv, "stall_auto_restart").as_deref() != Some("false"),
        include_manual_grabs: value(kv, "stall_include_manual_grabs").as_deref() == Some("true"),
        min_bytes_per_second: (if speed.is_finite() && speed > 0.0 {
            speed
        } else {
            8.0
        }) * 1024.0,
    })
}

pub fn stall() -> Result<Option<Stall>, String> {
    let keys = [
        "stall_samples",
        "stall_interval_minutes",
        "stall_auto_restart",
        "stall_include_manual_grabs",
        "stall_min_speed_kib",
    ];
    let kv = host::config_get(Some(
        &keys.iter().map(|k| (*k).to_owned()).collect::<Vec<_>>(),
    ))
    .map_err(|e| e.message)?;
    Ok(stall_of(&kv))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kv(p: &[(&str, &str)]) -> Vec<(String, String)> {
        p.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect()
    }

    #[test]
    fn search_budget() {
        assert_eq!(search_budget_ms_of(None), 30_000);
        assert_eq!(search_budget_ms_of(Some("abc")), 30_000);
        assert_eq!(search_budget_ms_of(Some("1")), 5_000);
        assert_eq!(search_budget_ms_of(Some("45s")), 45_000);
        assert_eq!(search_budget_ms_of(Some("999")), 120_000);
    }

    #[test]
    fn stall_rules() {
        assert!(stall_of(&kv(&[])).is_none());
        assert!(stall_of(&kv(&[("stall_samples", "1")])).is_none());
        let s = stall_of(&kv(&[
            ("stall_samples", "3"),
            ("stall_interval_minutes", "0"),
            ("stall_auto_restart", "no"),
        ]))
        .unwrap();
        assert_eq!(
            (
                s.samples,
                s.interval_minutes,
                s.auto_restart,
                s.include_manual_grabs
            ),
            (3, 60, true, false)
        );
        assert_eq!(s.min_bytes_per_second, 8192.0);
        let s = stall_of(&kv(&[
            ("stall_samples", "2"),
            ("stall_min_speed_kib", "0.5"),
            ("stall_include_manual_grabs", "true"),
        ]))
        .unwrap();
        assert_eq!(
            (s.min_bytes_per_second, s.include_manual_grabs),
            (512.0, true)
        );
    }
}

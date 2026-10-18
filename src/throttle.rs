//! The per-indexer throttle in `indexer_throttle`: a fenced one-request lease, spacing, failure
//! ladder and `Retry-After` windows, each one statement on the database clock.

use crate::db::{IndexerRow, exec, first, int, query, text};
use crate::error::R;
use fliks_plugin_sdk::db::Param;
use fliks_plugin_sdk::rt::{self, Budget};
use serde::Deserialize;
use std::time::Duration;

pub mod sql {
    /// 0 rows: another holder has the slot. `$1` id, `$2` token, `$3` lease s, `$4` delay ms.
    pub const CLAIM: &str = r#"INSERT INTO "indexer_throttle" ("indexerId", "busyToken", "busyUntil")
VALUES ($1, $2, now() + make_interval(secs => $3))
ON CONFLICT ("indexerId") DO UPDATE
   SET "busyToken" = EXCLUDED."busyToken", "busyUntil" = EXCLUDED."busyUntil", "updatedAt" = now()
 WHERE "indexer_throttle"."busyUntil" IS NULL OR "indexer_throttle"."busyUntil" <= now()
RETURNING GREATEST(0, LEAST($4::bigint, COALESCE(
  (EXTRACT(EPOCH FROM ("indexer_throttle"."nextAllowedAt" - now())) * 1000)::bigint, 0))) AS "waitMs""#;

    /// Fenced by the token. `$3` delay s, `$4` an [`Outcome`](super::Outcome): a request that was
    /// never sent leaves the spacing as it was.
    pub const RELEASE: &str = r#"UPDATE "indexer_throttle"
   SET "busyToken" = NULL, "busyUntil" = NULL,
       "nextAllowedAt" = CASE WHEN $4::text = 'not-started' THEN "nextAllowedAt"
                              ELSE now() + make_interval(secs => $3) END,
       "failureCount" = CASE WHEN $4::text = 'resolved' THEN 0 ELSE "failureCount" END,
       "cooldownUntil" = CASE WHEN $4::text = 'resolved' THEN NULL ELSE "cooldownUntil" END,
       "cooldownReason" = CASE WHEN $4::text = 'resolved' THEN NULL ELSE "cooldownReason" END,
       "cooldownFailureCount" = CASE WHEN $4::text = 'resolved' THEN NULL ELSE "cooldownFailureCount" END,
       "cooldownDetail" = CASE WHEN $4::text = 'resolved' THEN NULL ELSE "cooldownDetail" END,
       "updatedAt" = now()
 WHERE "indexerId" = $1 AND "busyToken" = $2"#;

    /// One ladder step, none while a window is open.
    pub const NOTIFY_FAILURE: &str = r#"WITH cur AS (
  SELECT "failureCount" + 1 AS n FROM "indexer_throttle"
   WHERE "indexerId" = $1 AND ("cooldownUntil" IS NULL OR "cooldownUntil" <= now()) FOR UPDATE),
step AS (
  SELECT n, now() + CASE LEAST(n, 5) WHEN 1 THEN interval '30 seconds'
     WHEN 2 THEN interval '2 minutes' WHEN 3 THEN interval '15 minutes'
     WHEN 4 THEN interval '1 hour' ELSE interval '6 hours' END AS until FROM cur)
UPDATE "indexer_throttle" t SET
  "failureCount" = step.n, "cooldownUntil" = step.until,
  "nextAllowedAt" = GREATEST(COALESCE(t."nextAllowedAt", '-infinity'), step.until),
  "cooldownReason" = 'failures', "cooldownFailureCount" = step.n, "cooldownDetail" = $2, "updatedAt" = now()
FROM step WHERE t."indexerId" = $1
RETURNING step.n AS "n""#;

    /// Monotonic on both gates; `$2` the window in ms, `$3` the header.
    pub const RETRY_AFTER: &str = r#"WITH w AS (SELECT now() + make_interval(secs => $2::float8 / 1000) AS until)
UPDATE "indexer_throttle" t SET
  "nextAllowedAt" = GREATEST(COALESCE(t."nextAllowedAt", '-infinity'), w.until),
  "cooldownReason" = CASE WHEN w.until > COALESCE(t."cooldownUntil", '-infinity') THEN 'rate-limit' ELSE t."cooldownReason" END,
  "cooldownFailureCount" = CASE WHEN w.until > COALESCE(t."cooldownUntil", '-infinity') THEN NULL ELSE t."cooldownFailureCount" END,
  "cooldownDetail" = CASE WHEN w.until > COALESCE(t."cooldownUntil", '-infinity') THEN $3 ELSE t."cooldownDetail" END,
  "cooldownUntil" = GREATEST(COALESCE(t."cooldownUntil", '-infinity'), w.until),
  "updatedAt" = now()
FROM w WHERE t."indexerId" = $1"#;

    /// Answers whether a window was open before the clear.
    pub const CLEAR: &str = r#"WITH old AS (
  SELECT "indexerId", COALESCE("cooldownUntil" > now(), false) AS had
    FROM "indexer_throttle" WHERE "indexerId" = $1 FOR UPDATE)
UPDATE "indexer_throttle" t SET
  "cooldownUntil" = NULL, "cooldownReason" = NULL, "cooldownFailureCount" = NULL, "cooldownDetail" = NULL,
  "failureCount" = 0, "nextAllowedAt" = NULL, "updatedAt" = now()
FROM old WHERE t."indexerId" = old."indexerId"
RETURNING old.had AS "had""#;

    pub const CLEAR_ALL: &str = r#"WITH old AS (
  SELECT "indexerId", COALESCE("cooldownUntil" > now(), false) AS had
    FROM "indexer_throttle" WHERE "cooldownUntil" IS NOT NULL OR "failureCount" <> 0 FOR UPDATE),
upd AS (
  UPDATE "indexer_throttle" t SET
    "cooldownUntil" = NULL, "cooldownReason" = NULL, "cooldownFailureCount" = NULL, "cooldownDetail" = NULL,
    "failureCount" = 0, "nextAllowedAt" = NULL, "updatedAt" = now()
  FROM old WHERE t."indexerId" = old."indexerId" RETURNING old.had)
SELECT (count(*) FILTER (WHERE had))::int AS "cleared" FROM upd"#;

    /// Open windows, with what `GET /indexers` shows of them.
    pub const COOLDOWNS: &str = r#"SELECT "indexerId", "cooldownReason" AS "reason",
  GREATEST(0, floor(EXTRACT(EPOCH FROM ("cooldownUntil" - now())) * 1000))::bigint AS "remainingMs",
  "cooldownUntil" AS "until", "cooldownFailureCount" AS "failureCount", "cooldownDetail" AS "detail"
  FROM "indexer_throttle" WHERE "cooldownUntil" > now()"#;
}

/// How long a slot is held at most: the spacing, the request itself and a margin.
fn lease_secs(ix: &IndexerRow, timeout: Duration) -> f64 {
    ix.request_delay.max(0) as f64 + timeout.as_secs_f64() + 10.0
}

const CLAIM_RETRY: Duration = Duration::from_millis(250);

fn token() -> String {
    #[cfg(target_arch = "wasm32")]
    let bytes = fliks_plugin_sdk::bindings::wasi::random::random::get_random_bytes(16);
    #[cfg(not(target_arch = "wasm32"))]
    let bytes = crate::util::now_ms().to_le_bytes().to_vec();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// How a slot ends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Outcome {
    Resolved,
    Threw,
    /// Cut short after it was sent.
    Cancelled,
    NotStarted,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Resolved => "resolved",
            Outcome::Threw => "threw",
            Outcome::Cancelled => "cancelled",
            Outcome::NotStarted => "not-started",
        }
    }
}

/// A held slot; dropping it unreleased frees it as cancelled, or not started if nothing was sent.
struct Slot {
    id: i64,
    token: String,
    delay_secs: f64,
    sent: bool,
    released: bool,
}

impl Slot {
    fn release(&mut self, outcome: Outcome) -> R<()> {
        self.released = true;
        exec(
            sql::RELEASE,
            &[
                int(self.id),
                text(&self.token),
                Param::Float(self.delay_secs),
                text(outcome.as_str()),
            ],
        )
        .map(drop)
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        if !self.released {
            let _ = self.release(if self.sent {
                Outcome::Cancelled
            } else {
                Outcome::NotStarted
            });
        }
    }
}

/// The round ran out: the request never started, or was cut short by the budget.
#[derive(Debug)]
pub struct Lapsed;

/// Runs `f` in the indexer's slot within `budget`; `f` gets its timeout and reports whether it
/// resolved. Dropping the future frees the slot.
pub async fn run<T, E, F: Future<Output = Result<T, E>>>(
    ix: &IndexerRow,
    budget: Budget,
    timeout: Duration,
    f: impl FnOnce(Duration) -> F,
) -> Result<Result<T, E>, Lapsed> {
    let delay_ms = ix.request_delay.max(0) * 1000;
    let token = token();
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Wait {
        wait_ms: i64,
    }
    let wait = loop {
        let claimed: Option<Wait> = first(
            sql::CLAIM,
            &[
                int(ix.id),
                text(&token),
                Param::Float(lease_secs(ix, timeout)),
                int(delay_ms),
            ],
        )
        .map_err(|e| {
            warn!("[{}] throttle claim failed: {e}", ix.name);
            Lapsed
        })?;
        if let Some(w) = claimed {
            break Duration::from_millis(w.wait_ms.max(0) as u64);
        }
        if CLAIM_RETRY >= budget.remaining() {
            return Err(Lapsed);
        }
        rt::sleep(CLAIM_RETRY).await;
    };
    let mut slot = Slot {
        id: ix.id,
        token,
        delay_secs: ix.request_delay.max(0) as f64,
        sent: false,
        released: false,
    };
    if wait >= budget.remaining() {
        return Err(Lapsed);
    }
    rt::sleep(wait).await;
    let left = budget.remaining();
    if left.is_zero() {
        return Err(Lapsed);
    }
    slot.sent = true;
    let out = f(timeout.min(left)).await;
    // Cut by the round, not by the indexer: released as cancelled, no failure step (DL6).
    if left < timeout && out.is_err() && budget.expired() {
        return Err(Lapsed);
    }
    let outcome = if out.is_ok() {
        Outcome::Resolved
    } else {
        Outcome::Threw
    };
    if let Err(e) = slot.release(outcome) {
        warn!("[{}] throttle release failed: {e}", ix.name);
    }
    Ok(out)
}

pub fn notify_failure(ix: &IndexerRow, detail: &str) {
    #[derive(Deserialize)]
    struct N {
        n: i64,
    }
    match first::<N>(sql::NOTIFY_FAILURE, &[int(ix.id), text(detail)]) {
        Ok(Some(N { n })) => {
            let secs = [30, 120, 900, 3600, 21600][(n.clamp(1, 5) - 1) as usize];
            warn!("[{}] consecutive failure #{n} — cooldown {secs}s", ix.name);
        }
        Ok(None) => {}
        Err(e) => warn!("[{}] throttle failure not recorded: {e}", ix.name),
    }
}

/// `Retry-After`: delta seconds or an HTTP date; the wait in ms, 0 when unparsable.
pub fn parse_retry_after(value: &str, now_ms: i64) -> i64 {
    let t = value.trim();
    if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) {
        return t.parse::<i64>().map_or(0, |s| s.saturating_mul(1000));
    }
    crate::util::parse_date_ms(t).map_or(0, |ts| (ts - now_ms).max(0))
}

pub fn set_retry_after(ix: &IndexerRow, header: Option<&str>) {
    let Some(h) = header else { return };
    let ms = parse_retry_after(h, crate::util::now_ms());
    if ms <= 0 {
        return;
    }
    match exec(
        sql::RETRY_AFTER,
        &[int(ix.id), Param::Float(ms as f64), text(h.trim())],
    ) {
        Ok(_) => warn!(
            "[{}] Retry-After honoured — next request in {}s",
            ix.name,
            (ms as f64 / 1000.0).round()
        ),
        Err(e) => warn!("[{}] Retry-After not recorded: {e}", ix.name),
    }
}

pub fn clear(id: i64) -> R<bool> {
    #[derive(Deserialize)]
    struct H {
        had: bool,
    }
    Ok(first::<H>(sql::CLEAR, &[int(id)])?.is_some_and(|h| h.had))
}

pub fn clear_all() -> R<i64> {
    #[derive(Deserialize)]
    struct C {
        cleared: i64,
    }
    Ok(first::<C>(sql::CLEAR_ALL, &[])?.map_or(0, |c| c.cleared))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cooldown {
    pub indexer_id: i64,
    pub reason: Option<String>,
    pub remaining_ms: i64,
    pub until: String,
    pub failure_count: Option<i64>,
    pub detail: Option<String>,
}

pub fn cooldowns() -> R<Vec<Cooldown>> {
    query(sql::COOLDOWNS, &[])
}

/// Drops indexers serving a cooldown from a fan-out, so a cooling one never stalls it.
pub fn filter_ready(indexers: &[IndexerRow]) -> R<Vec<IndexerRow>> {
    let cooling = cooldowns()?;
    let mut ready = vec![];
    let mut skipped = vec![];
    for ix in indexers {
        match cooling.iter().find(|c| c.indexer_id == ix.id) {
            Some(c) => skipped.push(format!(
                "{} ({}s)",
                ix.name,
                (c.remaining_ms as f64 / 1000.0).ceil()
            )),
            None => ready.push(ix.clone()),
        }
    }
    if !skipped.is_empty() {
        info!(
            "skipping {} indexer(s) in cooldown: {}",
            skipped.len(),
            skipped.join(", ")
        );
    }
    Ok(ready)
}

pub fn cooling(id: i64) -> bool {
    cooldowns().is_ok_and(|c| c.iter().any(|c| c.indexer_id == id))
}

#[cfg(test)]
mod tests {
    #[test]
    fn retry_after() {
        assert_eq!(super::parse_retry_after(" 120 ", 0), 120_000);
        assert_eq!(super::parse_retry_after("soon", 0), 0);
        let now = 1_704_067_200_000;
        assert_eq!(
            super::parse_retry_after("Mon, 01 Jan 2024 00:01:00 GMT", now),
            60_000
        );
        assert_eq!(
            super::parse_retry_after("Mon, 01 Jan 2024 00:00:00 GMT", now + 5),
            0
        );
    }
}

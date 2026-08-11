import type { IndexerRow } from '../db/rows';
import type { IndexerCooldown } from './types';
import { log } from '../log';

export type { IndexerCooldown } from './types';

/**
 * Serialises requests to each indexer and enforces a minimum delay between
 * them — public tracker portals (especially behind anti-DDoS) IP-ban clients
 * that exceed their tolerance. Layers three mechanisms:
 *   1. Per-indexer serial queue — one in-flight request at a time; other
 *      indexers stay parallel.
 *   2. Minimum `requestDelay` (seconds) between the START of two consecutive
 *      requests to the same indexer.
 *   3. `Retry-After` window on a 429/503 — overrides `requestDelay` upward,
 *      never downward.
 *   4. Progressive cooldown on consecutive failures — 30s → 2min → 15min →
 *      1h → 6h, at most one step per elapsed window. Resets on success.
 */
export class IndexerThrottle {
  /** Tail of the per-indexer promise chain. Awaiting it serialises the next
   *  operation behind all currently-queued ones. */
  private chains = new Map<number, Promise<unknown>>();
  /** Earliest wall-clock ms a new request to this indexer may start. Updated
   *  post-request (current + delay) AND on Retry-After (current + window). */
  private nextAllowedAt = new Map<number, number>();
  /** Consecutive failure count — drives progressive cooldown. */
  private failureCount = new Map<number, number>();
  /** Earliest ms a *penalised* indexer may be retried — written only by
   *  failure backoff and Retry-After, never by routine spacing. Lets a
   *  caller skip a backing-off indexer instead of queueing behind it. */
  private cooldownUntil = new Map<number, IndexerCooldown>();

  /** Queue `fn` against `indexer`. Rejections propagate untouched to the
   *  caller; failure metadata is still recorded for backoff. */
  async run<T>(indexer: IndexerRow, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(indexer.id) ?? Promise.resolve();
    const current = prev.then(() => this.runOne(indexer, fn));
    // Swallow at the chain level so one failure doesn't poison every queued
    // follower with an unhandled rejection; `await current` still sees it.
    this.chains.set(indexer.id, current.catch(() => undefined));
    return current;
  }

  private async runOne<T>(indexer: IndexerRow, fn: () => Promise<T>): Promise<T> {
    const delayMs = Math.max(0, indexer.requestDelay ?? 2) * 1000;
    const earliest = this.nextAllowedAt.get(indexer.id) ?? 0;
    const wait = earliest - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const result = await fn();
      this.notifySuccess(indexer.id);
      this.nextAllowedAt.set(indexer.id, Date.now() + delayMs);
      return result;
    } catch (e) {
      this.nextAllowedAt.set(indexer.id, Date.now() + delayMs);
      throw e;
    }
  }

  /** Honour a `Retry-After` value (seconds OR an absolute date). */
  setRetryAfter(indexer: IndexerRow, headerValue: string | undefined): void {
    const ms = parseRetryAfter(headerValue);
    if (ms <= 0) return;
    this.bumpCooldown(indexer.id, Date.now() + ms, {
      reason: 'rate-limit',
      detail: headerValue?.trim(),
    });
    log.warn(`[${indexer.name}] Retry-After honoured — next request in ${Math.round(ms / 1000)}s`);
  }

  /** Caller signals a transport-level failure. Escalates one step per elapsed
   *  window: failures inside an open cooldown belong to the outage that
   *  opened it, so the ladder tracks downtime, not request volume. */
  notifyFailure(indexer: IndexerRow, detail?: string): void {
    if (this.cooldownRemainingMs(indexer.id) > 0) return;
    const n = (this.failureCount.get(indexer.id) ?? 0) + 1;
    this.failureCount.set(indexer.id, n);
    const cooldownMs = backoffFor(n);
    if (cooldownMs <= 0) return;
    this.bumpCooldown(indexer.id, Date.now() + cooldownMs, {
      reason: 'failures',
      failureCount: n,
      detail,
    });
    log.warn(`[${indexer.name}] consecutive failure #${n} — cooldown ${Math.round(cooldownMs / 1000)}s`);
  }

  /** Reset the backoff state for an indexer on confirmed success. */
  notifySuccess(indexerId: number): void {
    this.failureCount.delete(indexerId);
    this.cooldownUntil.delete(indexerId);
  }

  /** Remaining failure / Retry-After cooldown, in ms (0 when ready). Routine
   *  request-delay spacing is excluded — a healthy indexer queried seconds
   *  ago still reads as ready. */
  cooldownRemainingMs(indexerId: number): number {
    const until = this.cooldownUntil.get(indexerId)?.until ?? 0;
    return Math.max(0, until - Date.now());
  }

  /** The live cooldown for an indexer, or null when it's ready. */
  getCooldown(indexerId: number): IndexerCooldown | null {
    const entry = this.cooldownUntil.get(indexerId);
    if (!entry || entry.until <= Date.now()) return null;
    return entry;
  }

  /** Lift a penalty window, including the queue gate `bumpCooldown` also
   *  pushed — otherwise the next request would sleep out the window this
   *  claims to have cancelled. Returns false when there was nothing to lift. */
  clearCooldown(indexerId: number): boolean {
    const had = this.cooldownRemainingMs(indexerId) > 0;
    this.cooldownUntil.delete(indexerId);
    this.failureCount.delete(indexerId);
    this.nextAllowedAt.delete(indexerId);
    return had;
  }

  /** Lift every penalty window. Returns how many indexers were in cooldown. */
  clearAllCooldowns(): number {
    let cleared = 0;
    for (const id of [...this.cooldownUntil.keys()]) {
      if (this.clearCooldown(id)) cleared++;
    }
    return cleared;
  }

  /** Bumps both the queue's earliest-start gate and the skip gate.
   *  Monotonic — only ever extends the window, never shortens it. */
  private bumpCooldown(indexerId: number, until: number, info: Omit<IndexerCooldown, 'until'>): void {
    const curNext = this.nextAllowedAt.get(indexerId) ?? 0;
    if (until > curNext) this.nextAllowedAt.set(indexerId, until);
    const curCooldown = this.cooldownUntil.get(indexerId)?.until ?? 0;
    if (until > curCooldown) {
      this.cooldownUntil.set(indexerId, { until, ...info });
    }
  }
}

/** `.unref()`: a queued-but-not-yet-due request must never be the thing keeping
 *  this process alive — other handles (the core socket) already do that. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

/** RFC 7231 §7.1.3: `Retry-After` is either a delta-seconds integer or an
 *  HTTP-date. Returns the wait in ms; 0 if unparseable. */
function parseRetryAfter(value: string | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  const ts = Date.parse(trimmed);
  if (!isNaN(ts)) {
    return Math.max(0, ts - Date.now());
  }
  return 0;
}

/** Progressive cooldown after consecutive failures. Caps at 6h so a
 *  permanently-broken indexer still occasionally probes for recovery. */
function backoffFor(failureCount: number): number {
  const steps = [
    30_000, // 1st failure → 30s
    2 * 60_000, // 2nd → 2 min
    15 * 60_000, // 3rd → 15 min
    60 * 60_000, // 4th → 1 h
    6 * 60 * 60_000, // 5th+ → 6 h
  ];
  return steps[Math.min(failureCount, steps.length) - 1] ?? 0;
}

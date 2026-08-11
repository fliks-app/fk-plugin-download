/**
 * Lands `completion.service.ts`'s plugin-side half: `processCompleted`,
 * `autoMatchOrphanTorrents`, `reconcileOrphanHistory`, `emitDownloadProgress`,
 * `cleanStalledTorrents`, `cleanSeededTorrents`. Real logic lives in
 * `src/grab/completion-poller.ts`; this file is the wiring point for whoever
 * connects the `ImportCompleted`/`CleanStalled`/`CleanSeeded` jobs
 * (`src/seams/jobs.ts`, out of scope here) to it, and calls `init()` once at
 * boot to re-arm any row left `importing` by a previous run.
 *
 * Broadened from its original one-`poll()`-method scaffold to one method per
 * manifest job — a single `poll()` could not distinguish which of the three
 * cron bodies a caller wanted.
 */
export interface CompletionPoller {
  /** The `ImportCompleted` job — the once-a-minute orphan sweep + import hand-off. */
  poll(): Promise<void>;
  /** The `CleanStalled` job. */
  cleanStalled(): Promise<void>;
  /** The `CleanSeeded` job. */
  cleanSeeded(): Promise<void>;
}

export { DownloadCompletionPoller, type CompletionPollerDeps } from '../grab/completion-poller';

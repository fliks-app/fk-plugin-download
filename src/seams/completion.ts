/** Lands `completion.service.ts`'s plugin-side half: `processCompleted`, `autoMatchOrphanTorrents`,
 *  `reconcileOrphanHistory`, `emitDownloadProgress`, `cleanStalledTorrents`, `cleanSeededTorrents`.
 *  Empty on purpose — driven by the `ImportCompleted`/`CleanStalled`/`CleanSeeded` jobs (`src/seams/jobs.ts`). */
export interface CompletionPoller {
  poll(): Promise<void>;
}

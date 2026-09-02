/**
 * Lands the torznab/newznab client, throttle and CRUD extracted from
 * `backend/src/plugins/download/indexers/**`. Real logic lives in
 * `src/indexers/**`; this file is the wiring point for whoever builds the
 * Postgres-backed `IndexerRepository`/`IndexerStatsRecorder` (`src/db/**`,
 * a separate module) and constructs a `TorznabClient` + `IndexerService` at
 * boot. No per-implementation registry: `IndexerService` accepts only
 * `"torznab"`, so — unlike `download-clients.ts`'s driver map — there is
 * nothing else to key on.
 */
import type { TorznabClient } from '../indexers/torznab';

export { TorznabClient, TorznabHttpError, type TorznabClientDeps } from '../indexers/torznab';
export { IndexerThrottle } from '../indexers/throttle';
export { IndexerService, redactApiKey, type IndexerServiceDeps } from '../indexers/service';
export { IndexerNotFoundError, UnknownIndexerImplementationError } from '../indexers/types';
export { USE_FOR_VALUES, gatesFor, isUseFor, isUseForList, useForOf, type UseFor } from '../indexers/use-for';
export type {
  CreateIndexerInput,
  IndexerConnectionMessageKey,
  IndexerConnectionTestResult,
  IndexerCooldown,
  IndexerRelease,
  IndexerRepository,
  IndexerStatsRecorder,
  IndexerWithCooldown,
  SearchKind,
  TestIndexerConnectionInput,
  UpdateIndexerInput,
} from '../indexers/types';

/** Everything a search/grab caller needs from one indexer client. */
export type IndexerDriver = Pick<
  TorznabClient,
  'searchMovie' | 'searchSeries' | 'searchSeasonPack' | 'rssSearch' | 'filterReadyIndexers' | 'refreshCaps' | 'testConnection'
>;

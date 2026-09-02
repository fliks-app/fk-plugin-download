/**
 * The import side of the indexers page: a saved Prowlarr / Jackett connection and the one-click
 * sync that turns what it has configured into ordinary torznab rows. Real logic lives in
 * `src/indexer-sources/**`; this file is the wiring point, mirroring `download-clients.ts`'s
 * driver map since there is more than one source to key on.
 */
export { INDEXER_SOURCE_DRIVERS } from '../indexer-sources/drivers';
export {
  IndexerSourceService,
  IndexerSourceDisabledError,
  type IndexerSourceServiceDeps,
  type ImportTargetIndexers,
} from '../indexer-sources/service';
export {
  IndexerSourceNotFoundError,
  SourceUnreachableError,
  UnknownIndexerSourceImplementationError,
} from '../indexer-sources/types';
export type {
  CreateIndexerSourceInput,
  ImportSummary,
  IndexerSourceDriver,
  RemoteIndexer,
  SourceSettings,
  SourceTestResult,
  TestIndexerSourceInput,
  UpdateIndexerSourceInput,
} from '../indexer-sources/types';

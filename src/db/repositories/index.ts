import type { Pool } from 'pg';
import { IndexersRepository } from './indexers.repository';
import { IndexerStatsRepository } from './indexer-stats.repository';
import { DownloadClientsRepository } from './download-clients.repository';
import { DownloadHistoryRepository } from './download-history.repository';
import { BlocklistRepository } from './blocklist.repository';
import { StalledChecksRepository } from './stalled-checks.repository';

export * from './indexers.repository';
export * from './indexer-stats.repository';
export * from './download-clients.repository';
export * from './download-history.repository';
export * from './blocklist.repository';
export * from './stalled-checks.repository';

export interface Repositories {
  indexers: IndexersRepository;
  indexerStats: IndexerStatsRepository;
  downloadClients: DownloadClientsRepository;
  downloadHistory: DownloadHistoryRepository;
  blocklist: BlocklistRepository;
  stalledChecks: StalledChecksRepository;
}

/** One instance of each repository, sharing the plugin's pool — the single entry point
 *  whoever wires the data layer into `src/plugin.ts`'s boot sequence needs. */
export function createRepositories(pool: Pool): Repositories {
  return {
    indexers: new IndexersRepository(pool),
    indexerStats: new IndexerStatsRepository(pool),
    downloadClients: new DownloadClientsRepository(pool),
    downloadHistory: new DownloadHistoryRepository(pool),
    blocklist: new BlocklistRepository(pool),
    stalledChecks: new StalledChecksRepository(pool),
  };
}

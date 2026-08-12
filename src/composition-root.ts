/**
 * Builds the object graph every seam declared but nothing constructed: repositories are
 * already live by the time this runs (`src/plugin.ts` creates the pool and migrates before
 * calling this), so this file only wires services on top of them, the job table and the
 * HTTP route table — once, at boot, never rebuilt.
 */
import type { Repositories, IndexersRepository, IndexerStatsRepository } from './db/repositories';
import type { HostCaller } from './grab/types';
import {
  IndexerThrottle,
  IndexerService,
  TorznabClient,
  IndexerNotFoundError,
  type IndexerRepository,
  type IndexerStatsRecorder,
} from './seams/indexers';
import { DOWNLOAD_CLIENT_DRIVERS, DownloadClientsService } from './seams/download-clients';
import { createGrabPipeline, type DownloadGrabPipeline } from './seams/grab-pipeline';
import { DownloadCompletionPoller } from './seams/completion';
import { TorrentHistoryMatcher } from './grab/torrent-name-matcher';
import { createJobHandlers, type JobHandler } from './seams/jobs';
import { createRouteTable, type RouteTable } from './seams/http-routes';
import { log } from './log';

/**
 * `IndexerService`/`TorznabClient` were ported against the abstract `IndexerRepository`/
 * `IndexerStatsRecorder` shapes (`src/indexers/types.ts`), which name different methods
 * than the concrete Postgres repos (`findOne` vs `findById`, `record` vs `insert`) and, for
 * `update`, a genuinely different contract (a partial patch the repo merges, vs the concrete
 * repo's full-row replace) — adapting here rather than changing either ported module.
 */
function toIndexerRepository(repo: IndexersRepository): IndexerRepository {
  return {
    findAll: () => repo.listAll(),
    findOne: (id) => repo.findById(id),
    insert: (row) => repo.insert(row),
    async update(id, patch) {
      const existing = await repo.findById(id);
      if (!existing) throw new IndexerNotFoundError(`Indexer #${id} not found`);
      return repo.update(id, { ...existing, ...patch });
    },
    refreshCaps: (id, caps) => repo.refreshCaps(id, caps),
    markSearchFallback: (id) => repo.markSearchFallback(id),
    remove: (id) => repo.remove(id),
  };
}

function toIndexerStatsRecorder(repo: IndexerStatsRepository): IndexerStatsRecorder {
  return {
    async record(stat) {
      await repo.insert(stat);
    },
  };
}

export interface AppGraph {
  indexerService: IndexerService;
  downloadClientsService: DownloadClientsService;
  grabPipeline: DownloadGrabPipeline;
  completionPoller: DownloadCompletionPoller;
  jobHandlers: Readonly<Record<string, JobHandler>>;
  routeTable: RouteTable;
}

export function createAppGraph(repositories: Repositories, host: HostCaller): AppGraph {
  const throttle = new IndexerThrottle();
  const indexerRepo = toIndexerRepository(repositories.indexers);
  const torznabClient = new TorznabClient({ stats: toIndexerStatsRecorder(repositories.indexerStats), repo: indexerRepo, throttle });
  const indexerService = new IndexerService({ repo: indexerRepo, torznab: torznabClient, throttle });

  // The plugin drives exactly one implementation today (`seams/download-clients.ts`'s
  // single-entry map) — the grab/completion flow takes one driver, not a keyed registry.
  const driver = DOWNLOAD_CLIENT_DRIVERS['qbittorrent']!;

  const grabPipeline = createGrabPipeline({
    host,
    indexer: torznabClient,
    driver,
    indexersRepo: repositories.indexers,
    clientsRepo: repositories.downloadClients,
    historyRepo: repositories.downloadHistory,
    blocklistRepo: repositories.blocklist,
  });

  const completionPoller = new DownloadCompletionPoller({
    host,
    driver,
    clientsRepo: repositories.downloadClients,
    indexersRepo: repositories.indexers,
    historyRepo: repositories.downloadHistory,
    stalledChecksRepo: repositories.stalledChecks,
    blocklistRepo: repositories.blocklist,
    historyMatcher: new TorrentHistoryMatcher(repositories.downloadHistory),
    // The deferred cross-link: the poller re-searches after a stalled-cleanup removal
    // by calling straight back into the pipeline that owns `SearchMissing`.
    searchMissing: (mediaIds) => grabPipeline.searchMissing(mediaIds),
  });

  const downloadClientsService = new DownloadClientsService({
    repo: repositories.downloadClients,
    drivers: DOWNLOAD_CLIENT_DRIVERS,
    history: repositories.downloadHistory,
    blocklist: repositories.blocklist,
    stalledSnapshots: repositories.stalledChecks,
    // Same cross-link as the poller's, fired after a manual blocklist-and-remove.
    onMediaBlocklisted: (mediaId) => {
      grabPipeline.searchMissing([mediaId]).catch((e: Error) => log.error(`re-search after blocklist failed: ${e.message}`));
    },
  });

  return {
    indexerService,
    downloadClientsService,
    grabPipeline,
    completionPoller,
    jobHandlers: createJobHandlers({ grabPipeline, completionPoller }),
    routeTable: createRouteTable({
      indexerService,
      downloadClientsService,
      grabPipeline,
      indexerStats: repositories.indexerStats,
      blocklist: repositories.blocklist,
      downloadHistory: repositories.downloadHistory,
      downloadClientsRepo: repositories.downloadClients,
      downloadClientDrivers: DOWNLOAD_CLIENT_DRIVERS,
      host,
    }),
  };
}

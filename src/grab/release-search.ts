import type { IndexerDriver } from '../seams/indexers';
import type { IndexerRow } from '../db/rows';
import type { IndexerRelease, SearchKind } from '../indexers/types';
import { searchBudgetMs } from '../search-budget';
import { log } from '../log';

/**
 * Every indexer fan-out in this module funnels through this one helper, which
 * calls `filterReadyIndexers` before anything else — the guarantee
 * `TorznabClient.filterReadyIndexers` exists for (a cooling indexer must never
 * stall a fan-out behind its full backoff) holds only if every caller applies
 * it, so this is the single choke point instead of each search site
 * re-implementing the filter. Mirrors `readyIndexersOrNone` in
 * `acquisition-scheduler.service.ts` / the inline `filterReadyIndexers` calls
 * in `movie-download.service.ts` / `episode-download.service.ts`.
 */
export function readyIndexersOrNone(indexer: IndexerDriver, indexers: IndexerRow[], context: string): IndexerRow[] {
  const ready = indexer.filterReadyIndexers(indexers);
  if (!ready.length && indexers.length) {
    log.warn(`${context}: every indexer is in cooldown — skipping this run`);
  }
  return ready;
}

export interface ExternalIds {
  imdbId?: string | null;
  tmdbId?: number | null;
  tvdbId?: number | null;
}

/** How one indexer ended: what it returned, or why none of its results are in the round. */
export type IndexerOutcome = { releases: IndexerRelease[] } | { failed: 'error' | 'timeout' };

/**
 * Observes a fan-out as it happens, so a caller streaming partial results reports
 * per-indexer state without re-deriving readiness — `readyIndexersOrNone` stays the only
 * place the cooldown filter is applied.
 */
export interface FanOutHooks {
  /** Which indexers this round queries, and which the cooldown filter dropped. */
  onRoster?(ready: IndexerRow[], skipped: IndexerRow[]): void;
  /** One indexer settled — once per ready indexer, in completion order. */
  onSettled?(indexer: IndexerRow, outcome: IndexerOutcome): void;
}

/** Resolves with what the indexer returned, or with why it contributed nothing once its
 *  budget lapses. The dropped work keeps running to its own fetch timeout; only its result
 *  is no longer waited on. */
function runOne(ix: IndexerRow, run: (ix: IndexerRow) => Promise<IndexerRelease[]>): Promise<IndexerOutcome> {
  const budgetMs = searchBudgetMs();
  let timer: NodeJS.Timeout | undefined;
  const lapsed = new Promise<IndexerOutcome>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`[${ix.name}] still searching after ${budgetMs}ms — dropped from this round`);
      resolve({ failed: 'timeout' });
    }, budgetMs);
  });
  const work = run(ix).then(
    (releases): IndexerOutcome => ({ releases }),
    (): IndexerOutcome => ({ failed: 'error' }),
  );
  return Promise.race([work, lapsed]).finally(() => clearTimeout(timer));
}

/**
 * Original result-set filtering (`parseSeasonEpisode`-based: drop releases
 * that clearly belong to a different episode/season, keep season packs and
 * unparseable titles for the scorer to judge) is not re-implemented here: it
 * lived in `common/release-scoring`/`common/release-parsing`, which this
 * plugin has no access to, and `releases.score` is called with the exact
 * same `seasonNumber`/`episodeNumber` context, so core's rejection rules are
 * assumed to cover the same "wrong episode" case server-side. Flagged in the
 * port report as a trust boundary, not a re-derivation.
 */
async function fanOut(
  ready: IndexerRow[],
  run: (ix: IndexerRow) => Promise<IndexerRelease[]>,
  hooks?: FanOutHooks,
): Promise<IndexerRelease[]> {
  const batches = await Promise.all(
    ready.map(async (ix) => {
      const outcome = await runOne(ix, run);
      hooks?.onSettled?.(ix, outcome);
      return 'releases' in outcome ? outcome.releases : [];
    }),
  );
  return batches.flat();
}

/** Resolves the ready set and reports the roster; `null` when nothing can be queried. */
function openRound(
  indexer: IndexerDriver,
  indexers: IndexerRow[],
  context: string,
  hooks?: FanOutHooks,
): IndexerRow[] | null {
  const ready = readyIndexersOrNone(indexer, indexers, context);
  if (hooks?.onRoster) {
    const readyIds = new Set(ready.map((ix) => ix.id));
    hooks.onRoster(
      ready,
      indexers.filter((ix) => !readyIds.has(ix.id)),
    );
  }
  return ready.length ? ready : null;
}

export async function searchMovieAcrossIndexers(
  indexer: IndexerDriver,
  indexers: IndexerRow[],
  kind: SearchKind,
  query: string,
  externalIds: ExternalIds,
  context = 'search',
  hooks?: FanOutHooks,
): Promise<IndexerRelease[]> {
  const ready = openRound(indexer, indexers, context, hooks);
  if (!ready) return [];
  return fanOut(ready, (ix) => indexer.searchMovie(ix, kind, query, externalIds), hooks);
}

export async function searchSeriesAcrossIndexers(
  indexer: IndexerDriver,
  indexers: IndexerRow[],
  kind: SearchKind,
  query: string,
  season: number,
  episode: number,
  externalIds: ExternalIds,
  context = 'search',
  hooks?: FanOutHooks,
): Promise<IndexerRelease[]> {
  const ready = openRound(indexer, indexers, context, hooks);
  if (!ready) return [];
  return fanOut(ready, (ix) => indexer.searchSeries(ix, kind, query, season, episode, externalIds), hooks);
}

export async function searchSeasonPackAcrossIndexers(
  indexer: IndexerDriver,
  indexers: IndexerRow[],
  kind: SearchKind,
  query: string,
  season: number,
  externalIds: ExternalIds,
  context = 'search',
  hooks?: FanOutHooks,
): Promise<IndexerRelease[]> {
  const ready = openRound(indexer, indexers, context, hooks);
  if (!ready) return [];
  return fanOut(ready, (ix) => indexer.searchSeasonPack(ix, kind, query, season, externalIds), hooks);
}

/** RSS: each indexer's own feed, tagged with its id so the caller can dedupe
 *  per-indexer and keep publishing progress per-indexer like the original. */
export async function rssAcrossIndexers(
  indexer: IndexerDriver,
  indexers: IndexerRow[],
  context = 'RssSync',
): Promise<{ indexer: IndexerRow; releases: IndexerRelease[] }[]> {
  const ready = readyIndexersOrNone(indexer, indexers, context);
  const out: { indexer: IndexerRow; releases: IndexerRelease[] }[] = [];
  for (const ix of ready) {
    try {
      out.push({ indexer: ix, releases: await indexer.rssSearch(ix) });
    } catch (e) {
      log.warn(`RssSync: indexer "${ix.name}" failed: ${(e as Error).message}`);
    }
  }
  return out;
}

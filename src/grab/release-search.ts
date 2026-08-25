import type { IndexerDriver } from '../seams/indexers';
import type { IndexerRow } from '../db/rows';
import type { IndexerRelease } from '../indexers/types';
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

/**
 * Ceiling on one indexer's contribution to a fan-out, and so on the whole fan-out — they
 * run concurrently, so the slowest one sets the wall clock. Sized for the reverse proxy in
 * front of Fliks rather than for core's 180s plugin-call deadline: nginx and friends default
 * to a 60s read timeout, and a 504 there discards every indexer that had already answered.
 * Above this the slow one is dropped and the rest are returned.
 */
const INDEXER_BUDGET_MS = 30_000;

/** Resolves with what the indexer returned, or with nothing once its budget lapses. The
 *  dropped work keeps running to its own fetch timeout; only its result is no longer waited on. */
function withinBudget<T>(work: Promise<T[]>, name: string): Promise<T[]> {
  let timer: NodeJS.Timeout | undefined;
  const lapsed = new Promise<T[]>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`[${name}] still searching after ${INDEXER_BUDGET_MS}ms — dropped from this round`);
      resolve([]);
    }, INDEXER_BUDGET_MS);
  });
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
async function fanOut<T>(
  ready: IndexerRow[],
  run: (ix: IndexerRow) => Promise<T[]>,
): Promise<T[]> {
  // The catch is what `allSettled` used to do; the budget is what it could not.
  const batches = await Promise.all(
    ready.map((ix) => withinBudget(run(ix).catch(() => [] as T[]), ix.name)),
  );
  return batches.flat();
}

export async function searchMovieAcrossIndexers(
  indexer: IndexerDriver,
  indexers: IndexerRow[],
  query: string,
  externalIds: ExternalIds,
  context = 'search',
): Promise<IndexerRelease[]> {
  const ready = readyIndexersOrNone(indexer, indexers, context);
  if (!ready.length) return [];
  return fanOut(ready, (ix) => indexer.searchMovie(ix, query, externalIds));
}

export async function searchSeriesAcrossIndexers(
  indexer: IndexerDriver,
  indexers: IndexerRow[],
  query: string,
  season: number,
  episode: number,
  externalIds: ExternalIds,
  context = 'search',
): Promise<IndexerRelease[]> {
  const ready = readyIndexersOrNone(indexer, indexers, context);
  if (!ready.length) return [];
  return fanOut(ready, (ix) => indexer.searchSeries(ix, query, season, episode, externalIds));
}

export async function searchSeasonPackAcrossIndexers(
  indexer: IndexerDriver,
  indexers: IndexerRow[],
  query: string,
  season: number,
  externalIds: ExternalIds,
  context = 'search',
): Promise<IndexerRelease[]> {
  const ready = readyIndexersOrNone(indexer, indexers, context);
  if (!ready.length) return [];
  return fanOut(ready, (ix) => indexer.searchSeasonPack(ix, query, season, externalIds));
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

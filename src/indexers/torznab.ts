import type { IndexerRow } from '../db/rows';
import type { IndexerConnectionTestResult, IndexerRelease, IndexerRepository, IndexerStatsRecorder } from './types';
import { buildTorznabQuery, describeTorznabQuery, parseTorznabItems } from './torznab-parse';
import { IndexerThrottle } from './throttle';
import { searchFetchTimeoutMs } from '../search-budget';
import { log } from '../log';

const USER_AGENT = 'Fliks/1.0';

/** A response outside the caller's accepted status range. Carries `retryAfter`
 *  so 429/503 handling doesn't need an axios-style `isAxiosError` check. */
export class TorznabHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super(`HTTP ${status}`);
  }
}

interface FetchOptions {
  timeoutMs: number;
  /** Omitted = never throw on status, matching axios `validateStatus: () => true`. */
  validateStatus?: (status: number) => boolean;
  /** Merged over the User-Agent. For an API that authenticates on a header or a cookie. */
  headers?: Record<string, string>;
  /** `'manual'` to read a redirect rather than follow it: following one loses the `Set-Cookie`
   *  the redirect carried, which is the whole answer for a session-gated API. */
  redirect?: 'manual' | 'follow';
}

/**
 * `fetch` reports every transport failure as the same `TypeError: fetch failed`, with the
 * real reason hidden on `cause` — so a DNS miss, a refused port and a reset socket all
 * reach the logs and the indexer's error column as one useless string. An abort is worth
 * naming too: it is this client's own timeout, not the far end's answer.
 */
function describeFetchError(e: unknown, timeoutMs: number): string {
  const err = e as { name?: string; message?: string; cause?: { message?: string; code?: string } };
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return `timed out after ${timeoutMs}ms`;
  const cause = err?.cause;
  if (!cause?.message) return err?.message ?? String(e);
  const code = cause.code && !cause.message.includes(cause.code) ? ` (${cause.code})` : '';
  return `${err.message ?? 'request failed'}: ${cause.message}${code}`;
}

export async function fetchText(url: string, opts: FetchOptions): Promise<{ status: number; body: string; headers: Headers }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...opts.headers },
      ...(opts.redirect ? { redirect: opts.redirect } : {}),
    });
    const body = await res.text();
    if (opts.validateStatus && !opts.validateStatus(res.status)) {
      throw new TorznabHttpError(res.status, res.headers.get('retry-after'));
    }
    return { status: res.status, body, headers: res.headers };
  } catch (e) {
    // The status error carries its own meaning, and `maybeHandleRateLimit` matches on its type.
    if (e instanceof TorznabHttpError) throw e;
    throw new Error(describeFetchError(e, opts.timeoutMs), { cause: e });
  } finally {
    clearTimeout(timer);
  }
}

export interface TorznabClientDeps {
  stats: IndexerStatsRecorder;
  repo: Pick<IndexerRepository, 'update' | 'refreshCaps' | 'markSearchFallback'>;
  throttle: IndexerThrottle;
}

export class TorznabClient {
  constructor(private readonly deps: TorznabClientDeps) {}

  /** Drops indexers currently serving a failure / Retry-After cooldown from a
   *  search fan-out. Without this, the throttle would sleep the next queued
   *  call out for the full backoff (up to 6h) before firing — stalling a whole
   *  `Promise.all`/`Promise.allSettled` fan-out, and an interactive search with
   *  it, behind one broken host. A cooled indexer rejoins automatically once
   *  its cooldown lapses; a healthy one queried seconds ago is never skipped. */
  filterReadyIndexers(indexers: IndexerRow[]): IndexerRow[] {
    const ready: IndexerRow[] = [];
    const skipped: string[] = [];
    for (const ix of indexers) {
      const remainingMs = this.deps.throttle.cooldownRemainingMs(ix.id);
      if (remainingMs > 0) {
        skipped.push(`${ix.name} (${Math.ceil(remainingMs / 1000)}s)`);
      } else {
        ready.push(ix);
      }
    }
    if (skipped.length) {
      log.info(`skipping ${skipped.length} indexer(s) in cooldown: ${skipped.join(', ')}`);
    }
    return ready;
  }

  /** Detects Retry-After-bearing statuses (429, 503) and feeds the header to
   *  the throttle. Returns true when the failure was rate-limit-shaped. */
  private maybeHandleRateLimit(indexer: IndexerRow, e: unknown): boolean {
    if (!(e instanceof TorznabHttpError)) return false;
    if (e.status === 429 || e.status === 503) {
      this.deps.throttle.setRetryAfter(indexer, e.retryAfter ?? undefined);
      return true;
    }
    return false;
  }

  /** Calls `t=caps` and persists the result, resetting `capsSearchFallback` so a
   *  reconfigured indexer gets a clean slate. Runs regardless of enabled/enableSearch
   *  so a freshly (re)configured indexer always gets caps before an admin flips it on. */
  async refreshCaps(indexer: IndexerRow): Promise<void> {
    const target = this.resolveEndpoint(indexer);
    if (!target) return;
    const { baseUrl, apiKey } = target;

    let res: Awaited<ReturnType<typeof fetchText>>;
    try {
      res = await this.deps.throttle.run(indexer, () =>
        fetchText(`${baseUrl}?t=caps&apikey=${encodeURIComponent(apiKey)}`, {
          timeoutMs: 10_000,
          // Without this a 429 or a 5xx reads as a valid answer, and the probe records
          // "supports neither" from a body the tracker never sent.
          validateStatus: (status) => status >= 200 && status < 400,
        }),
      );
    } catch (e) {
      this.maybeHandleRateLimit(indexer, e);
      this.deps.throttle.notifyFailure(indexer, (e as Error).message);
      // Nothing is written: a transient failure must not read back as "supports neither",
      // which is what pinned an indexer to text-only search until someone edited it.
      log.warn(`[${indexer.name}] caps fetch failed: ${(e as Error).message}`);
      return;
    }

    const torznabError = this.torznabError(res.body);
    if (torznabError) {
      this.deps.throttle.notifyFailure(indexer, torznabError);
      log.warn(`[${indexer.name}] caps refused: ${torznabError}`);
      return;
    }

    const capsMovieSearch = /<movie-search\s[^>]*available="yes"/i.test(res.body);
    const capsTvSearch = /<tv-search\s[^>]*available="yes"/i.test(res.body);
    log.info(`[${indexer.name}] caps refreshed — movieSearch=${capsMovieSearch}, tvSearch=${capsTvSearch}`);

    await this.deps.repo.refreshCaps(indexer.id, { capsMovieSearch, capsTvSearch, capsSearchFallback: false });
    indexer.capsMovieSearch = capsMovieSearch;
    indexer.capsTvSearch = capsTvSearch;
    indexer.capsSearchFallback = false;
    indexer.capsProbedAt = new Date().toISOString();
  }

  /**
   * Probes on first use: an indexer whose only probe failed would otherwise stay on
   * text-only search for good, since nothing else ever asks again. False means the probe
   * left it cooling down — searching now would just sleep out the cooldown.
   */
  private async ensureCapsProbed(indexer: IndexerRow): Promise<boolean> {
    if (indexer.capsProbedAt) return true;
    if (this.deps.throttle.cooldownRemainingMs(indexer.id) > 0) return true;
    await this.refreshCaps(indexer);
    return this.deps.throttle.cooldownRemainingMs(indexer.id) === 0;
  }

  /** The endpoint for this indexer, independent of enabled/enableRss/enableSearch —
   *  each caller applies its own gate. Null means unresolvable. */
  private resolveEndpoint(indexer: IndexerRow): { baseUrl: string; apiKey: string } | null {
    const settings = indexer.settings as { baseUrl?: string; apiKey?: string };
    const implementation = indexer.implementation || '';

    if (!implementation.toLowerCase().includes('torznab')) {
      log.info(`[${indexer.name}] skipped — implementation "${indexer.implementation}" is not Torznab`);
      return null;
    }
    const baseUrl = String(settings.baseUrl || '').replace(/\/$/, '');
    if (!baseUrl) {
      log.warn(`Indexer "${indexer.name}" has no baseUrl`);
      return null;
    }
    return { baseUrl, apiKey: String(settings.apiKey || '') };
  }

  /** Gates a search call on enabled/enableSearch, then resolves the endpoint. */
  private resolveSearchTarget(indexer: IndexerRow): { baseUrl: string; apiKey: string } | null {
    if (!indexer.enabled) {
      log.info(`[${indexer.name}] skipped — indexer disabled`);
      return null;
    }
    if (!indexer.enableSearch) {
      log.info(`[${indexer.name}] skipped — search disabled`);
      return null;
    }
    return this.resolveEndpoint(indexer);
  }

  /** A Torznab error arrives as a 200 with an `<error>` element — an invalid key looks
   *  exactly like a successful empty response otherwise. */
  private torznabError(body: string): string | null {
    if (!/<error\s+code=/i.test(body)) return null;
    return body.match(/description="([^"]*)"/i)?.[1]?.trim() || 'Torznab error';
  }

  /** Executes a Torznab search URL. Returns results and the Torznab error message, if any. */
  private async execSearch(
    url: string,
    queryType: string,
    indexer: IndexerRow,
  ): Promise<{ results: IndexerRelease[]; torznabError: string | null }> {
    const query = describeTorznabQuery(url);
    const start = Date.now();
    try {
      const res = await this.deps.throttle.run(indexer, () =>
        fetchText(url, { timeoutMs: searchFetchTimeoutMs(), validateStatus: (s) => s >= 200 && s < 400 }),
      );
      const torznabError = this.torznabError(res.body);
      if (torznabError) {
        const msg = torznabError;
        void this.deps.stats.record({
          indexerId: indexer.id,
          queryType,
          responseTimeMs: Date.now() - start,
          resultCount: 0,
          errorMessage: msg,
        });
        log.warn(`[${indexer.name}] ${query} → ${msg}`);
        return { results: [], torznabError: msg };
      }
      const results = parseTorznabItems(res.body, indexer);
      void this.deps.stats.record({
        indexerId: indexer.id,
        queryType,
        responseTimeMs: Date.now() - start,
        resultCount: results.length,
        errorMessage: null,
      });
      log.info(`[${indexer.name}] ${query} → ${results.length} result(s) in ${Date.now() - start}ms`);
      return { results, torznabError: null };
    } catch (e) {
      this.maybeHandleRateLimit(indexer, e);
      this.deps.throttle.notifyFailure(indexer, (e as Error).message);
      const msg = (e as Error).message;
      void this.deps.stats.record({
        indexerId: indexer.id,
        queryType,
        responseTimeMs: Date.now() - start,
        resultCount: 0,
        errorMessage: msg,
      });
      log.warn(`[${indexer.name}] ${query} failed: ${msg}`);
      return { results: [], torznabError: msg };
    }
  }

  /** If caps claimed typed-search support but it failed, retry with `t=search`. On
   *  success, persists `capsSearchFallback=true` so future calls skip the caps check. */
  private async retryWithSearchFallback(
    indexer: IndexerRow,
    fallbackUrl: string,
    queryType: string,
  ): Promise<IndexerRelease[]> {
    const { results, torznabError } = await this.execSearch(fallbackUrl, queryType, indexer);
    if (torznabError) return []; // indexer unavailable, don't save
    log.info(`[${indexer.name}] t=search fallback succeeded — saving capsSearchFallback=true`);
    void this.deps.repo.markSearchFallback(indexer.id).catch((e: unknown) => {
      log.warn(`[${indexer.name}] could not persist the search fallback: ${String(e)}`);
    });
    indexer.capsSearchFallback = true; // in-memory, so later calls in the same batch see it
    return results;
  }

  /** Calls `t=caps` to validate a URL/API key pair before an indexer row exists. No
   *  throttle key to use yet — fired sporadically from the UI, safe to bypass the queue. */
  async testConnection(baseUrl: string, apiKey: string): Promise<IndexerConnectionTestResult> {
    const base = String(baseUrl || '').replace(/\/$/, '');
    if (!base) {
      return { ok: false, messageKey: 'download.indexers.test.base_url_missing' };
    }
    const url = `${base}?t=caps&apikey=${encodeURIComponent(apiKey || '')}`;
    try {
      const res = await fetchText(url, { timeoutMs: 30_000 });
      if (res.status >= 400) {
        return { ok: false, messageKey: 'download.indexers.test.http_error', detail: String(res.status) };
      }
      if (/<error\s+code=/i.test(res.body)) {
        const detail = res.body.match(/description="([^"]*)"/i)?.[1]?.trim();
        return { ok: false, messageKey: 'download.indexers.test.torznab_error', detail };
      }
      if (!/<caps/i.test(res.body)) {
        return { ok: false, messageKey: 'download.indexers.test.unexpected_response' };
      }
      return { ok: true, messageKey: 'download.indexers.test.ok' };
    } catch (e) {
      return { ok: false, messageKey: 'download.indexers.test.network_error', detail: (e as Error).message };
    }
  }

  /** RSS feed fetch — `t=search` with no query returns recent releases. */
  async rssSearch(indexer: IndexerRow): Promise<IndexerRelease[]> {
    if (!indexer.enabled || !indexer.enableRss) return [];
    const target = this.resolveEndpoint(indexer);
    if (!target) return [];
    const { baseUrl, apiKey } = target;

    const url = `${baseUrl}?t=search&q=&cat=2000&apikey=${encodeURIComponent(apiKey)}`;
    const start = Date.now();
    try {
      const res = await this.deps.throttle.run(indexer, () =>
        fetchText(url, { timeoutMs: 60_000, validateStatus: (s) => s >= 200 && s < 400 }),
      );
      const results = parseTorznabItems(res.body, indexer);
      void this.deps.stats.record({
        indexerId: indexer.id,
        queryType: 'rss',
        responseTimeMs: Date.now() - start,
        resultCount: results.length,
        errorMessage: null,
      });
      return results;
    } catch (e) {
      this.maybeHandleRateLimit(indexer, e);
      this.deps.throttle.notifyFailure(indexer, (e as Error).message);
      void this.deps.stats.record({
        indexerId: indexer.id,
        queryType: 'rss',
        responseTimeMs: Date.now() - start,
        resultCount: 0,
        errorMessage: (e as Error).message,
      });
      log.warn(`RSS sync failed for "${indexer.name}": ${(e as Error).message}`);
      return [];
    }
  }

  /** Searches for a season pack (no episode number → indexer returns whole-season packs). */
  async searchSeasonPack(
    indexer: IndexerRow,
    showTitle: string,
    season: number,
    externalIds?: { tvdbId?: number | null; imdbId?: string | null },
  ): Promise<IndexerRelease[]> {
    const target = this.resolveSearchTarget(indexer);
    if (!target) return [];
    const { baseUrl, apiKey } = target;

    if (!(await this.ensureCapsProbed(indexer))) return [];
    const useTvSearch = indexer.capsTvSearch && !indexer.capsSearchFallback;
    // Text-mode search needs the season tag baked into `q` so the indexer's own
    // result cap doesn't bury packs for popular shows below the cutoff.
    const searchQ = useTvSearch ? showTitle : `${showTitle} S${String(season).padStart(2, '0')}`;
    const typedUrl = `${baseUrl}?${buildTorznabQuery({
      t: useTvSearch ? 'tvsearch' : 'search',
      q: searchQ,
      season: useTvSearch ? season : undefined,
      cat: '5000',
      apiKey,
      tvdbId: useTvSearch ? externalIds?.tvdbId : undefined,
      imdbId: useTvSearch ? externalIds?.imdbId : undefined,
    })}`;

    const { results, torznabError } = await this.execSearch(typedUrl, 'season', indexer);
    if (!torznabError) return results;

    if (useTvSearch) {
      log.warn(`[${indexer.name}] tvsearch failed (${torznabError}), falling back to t=search`);
      const fallbackQ = `${showTitle} S${String(season).padStart(2, '0')}`;
      return this.retryWithSearchFallback(
        indexer,
        `${baseUrl}?${buildTorznabQuery({ t: 'search', q: fallbackQ, cat: '5000', apiKey })}`,
        'season',
      );
    }
    return [];
  }

  async searchSeries(
    indexer: IndexerRow,
    showTitle: string,
    season: number,
    episode: number,
    externalIds?: { tvdbId?: number | null; imdbId?: string | null },
  ): Promise<IndexerRelease[]> {
    const target = this.resolveSearchTarget(indexer);
    if (!target) return [];
    const { baseUrl, apiKey } = target;

    if (!(await this.ensureCapsProbed(indexer))) return [];
    // Season 0 is a special: `season=0&ep=3` matches only a release tagged `S00E03`, which is
    // not a form anything publishes, and an `S00` tag on `q` matches nothing either. The
    // caller has put the episode title in `showTitle`, so a plain text search is the one
    // query that can answer.
    const isSpecial = season === 0;
    const useTvSearch =
      indexer.capsTvSearch && !indexer.capsSearchFallback && !isSpecial;
    // See searchSeasonPack: appending the season tag to a plain-text `q` keeps
    // popular series from filling the indexer's result cap with loud 1080p hits.
    const searchQ =
      useTvSearch || isSpecial ? showTitle : `${showTitle} S${String(season).padStart(2, '0')}`;
    const typedUrl = `${baseUrl}?${buildTorznabQuery({
      t: useTvSearch ? 'tvsearch' : 'search',
      q: searchQ,
      season: useTvSearch ? season : undefined,
      ep: useTvSearch ? episode : undefined,
      cat: '5000',
      apiKey,
      tvdbId: useTvSearch ? externalIds?.tvdbId : undefined,
      imdbId: useTvSearch ? externalIds?.imdbId : undefined,
    })}`;

    const { results, torznabError } = await this.execSearch(typedUrl, 'tvsearch', indexer);
    if (!torznabError) return results;

    if (useTvSearch) {
      log.warn(`[${indexer.name}] tvsearch failed (${torznabError}), falling back to t=search`);
      const fallbackQ = `${showTitle} S${String(season).padStart(2, '0')}`;
      return this.retryWithSearchFallback(
        indexer,
        `${baseUrl}?${buildTorznabQuery({ t: 'search', q: fallbackQ, cat: '5000', apiKey })}`,
        'tvsearch',
      );
    }
    return [];
  }

  async searchMovie(
    indexer: IndexerRow,
    query: string,
    externalIds?: { imdbId?: string | null; tmdbId?: number | null },
  ): Promise<IndexerRelease[]> {
    const target = this.resolveSearchTarget(indexer);
    if (!target) return [];
    const { baseUrl, apiKey } = target;

    if (!(await this.ensureCapsProbed(indexer))) return [];
    const useMovieSearch =
      indexer.capsMovieSearch && !indexer.capsSearchFallback && !!(externalIds?.imdbId || externalIds?.tmdbId);

    const typedUrl = `${baseUrl}?${buildTorznabQuery({
      t: useMovieSearch ? 'movie' : 'search',
      q: query,
      cat: '2000',
      apiKey,
      imdbId: useMovieSearch ? externalIds?.imdbId : undefined,
      tmdbId: useMovieSearch ? externalIds?.tmdbId : undefined,
    })}`;

    const { results, torznabError } = await this.execSearch(typedUrl, 'search', indexer);
    if (!torznabError) return results;

    if (useMovieSearch) {
      log.warn(`[${indexer.name}] t=movie failed (${torznabError}), falling back to t=search`);
      return this.retryWithSearchFallback(
        indexer,
        `${baseUrl}?${buildTorznabQuery({ t: 'search', q: query, cat: '2000', apiKey })}`,
        'search',
      );
    }

    log.warn(`[${indexer.name}] search failed: ${torznabError}`);
    return [];
  }
}

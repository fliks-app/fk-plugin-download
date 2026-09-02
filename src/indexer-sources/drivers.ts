import { fetchText } from '../indexers/torznab';
import {
  SourceUnreachableError,
  type IndexerSourceDriver,
  type RemoteIndexer,
  type RemoteIndexerList,
  type SourceSettings,
  type SourceTestResult,
} from './types';

const FETCH_TIMEOUT_MS = 15_000;

const KEYS = {
  baseUrlMissing: 'download.indexer_sources.test.base_url_missing',
  httpError: 'download.indexer_sources.test.http_error',
  unexpectedResponse: 'download.indexer_sources.test.unexpected_response',
  networkError: 'download.indexer_sources.test.network_error',
  ok: 'download.indexer_sources.test.ok',
} as const;

/** No trailing slash: every endpoint below appends its own, and a doubled one is a 404 on both
 *  sources. */
function normalizeBase(baseUrl: string): string {
  return String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
}

/** Both sources answer their list as a JSON array. Anything else (an HTML login page from a
 *  reverse proxy, an error object) is the source refusing, not an empty list. */
async function fetchList(url: string, what: string): Promise<unknown[]> {
  let res: { status: number; body: string };
  try {
    res = await fetchText(url, { timeoutMs: FETCH_TIMEOUT_MS });
  } catch (e) {
    throw new SourceUnreachableError(`${what} unreachable`, KEYS.networkError, (e as Error).message);
  }
  if (res.status >= 400) {
    throw new SourceUnreachableError(`${what} answered HTTP ${res.status}`, KEYS.httpError, String(res.status));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body) as unknown;
  } catch {
    throw new SourceUnreachableError(`${what} answered a non-JSON body`, KEYS.unexpectedResponse);
  }
  if (!Array.isArray(parsed)) {
    throw new SourceUnreachableError(`${what} answered ${typeof parsed}, not a list`, KEYS.unexpectedResponse);
  }
  return parsed;
}

async function testViaList(settings: SourceSettings, list: () => Promise<unknown>): Promise<SourceTestResult> {
  if (!normalizeBase(settings.baseUrl)) return { ok: false, messageKey: KEYS.baseUrlMissing };
  try {
    await list();
    return { ok: true, messageKey: KEYS.ok };
  } catch (e) {
    const err = e as SourceUnreachableError;
    return { ok: false, messageKey: err.messageKey ?? KEYS.networkError, detail: err.detail ?? err.message };
  }
}

function requireBase(settings: SourceSettings, what: string): string {
  const base = normalizeBase(settings.baseUrl);
  if (!base) throw new SourceUnreachableError(`${what} has no base URL`, KEYS.baseUrlMissing);
  return base;
}

/**
 * Prowlarr. `GET /api/v1/indexer` lists what it manages; each entry is queryable over torznab
 * at `<base>/<id>/api` with Prowlarr's own API key, the same endpoint its other clients use.
 * A `usenet` entry has no torznab endpoint here, so it is counted as unsupported.
 */
const prowlarr: IndexerSourceDriver = {
  async fetchIndexers(settings: SourceSettings): Promise<RemoteIndexerList> {
    const base = requireBase(settings, 'prowlarr');
    const rows = await fetchList(
      `${base}/api/v1/indexer?apikey=${encodeURIComponent(settings.apiKey)}`,
      'prowlarr',
    );
    const indexers: RemoteIndexer[] = [];
    let unsupported = 0;
    for (const raw of rows) {
      const row = (raw ?? {}) as { id?: unknown; name?: unknown; enable?: unknown; protocol?: unknown };
      const id = typeof row.id === 'number' || typeof row.id === 'string' ? String(row.id) : '';
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      if (!id || !name) continue;
      if (row.protocol !== undefined && row.protocol !== 'torrent') {
        unsupported++;
        continue;
      }
      indexers.push({
        externalId: id,
        name,
        baseUrl: `${base}/${encodeURIComponent(id)}/api`,
        enabled: row.enable !== false,
      });
    }
    return { indexers, unsupported };
  },

  testConnection(settings: SourceSettings): Promise<SourceTestResult> {
    return testViaList(settings, () => prowlarr.fetchIndexers(settings));
  },
};

/**
 * Jackett. `GET /api/v2.0/indexers?configured=true` lists the trackers the admin has set up;
 * each is queryable at `<base>/api/v2.0/indexers/<id>/results/torznab/` with Jackett's API key.
 */
const jackett: IndexerSourceDriver = {
  async fetchIndexers(settings: SourceSettings): Promise<RemoteIndexerList> {
    const base = requireBase(settings, 'jackett');
    const rows = await fetchList(
      `${base}/api/v2.0/indexers?configured=true&apikey=${encodeURIComponent(settings.apiKey)}`,
      'jackett',
    );
    const indexers: RemoteIndexer[] = [];
    for (const raw of rows) {
      const row = (raw ?? {}) as { id?: unknown; name?: unknown; configured?: unknown };
      const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : '';
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      if (!id || !name) continue;
      // `configured=true` is a request, not a promise: older Jackett builds answer the full
      // catalogue, and importing 500 unconfigured trackers is not what the button says.
      if (row.configured === false) continue;
      indexers.push({
        externalId: id,
        name,
        baseUrl: `${base}/api/v2.0/indexers/${encodeURIComponent(id)}/results/torznab/`,
        enabled: true,
      });
    }
    return { indexers, unsupported: 0 };
  },

  testConnection(settings: SourceSettings): Promise<SourceTestResult> {
    return testViaList(settings, () => jackett.fetchIndexers(settings));
  },
};

export const INDEXER_SOURCE_DRIVERS: Readonly<Record<string, IndexerSourceDriver>> = {
  prowlarr,
  jackett,
};

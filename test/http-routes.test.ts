/**
 * The route table's own matching, exercised directly (no socket, no DB) so every
 * adversarial case runs fast and asserts precisely. `test/harness.test.ts` covers the
 * same shape once over the real socket as proof core can actually reach it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRouteTable,
  canonicalRoutes,
  ROUTES,
  type RouteDeps,
  type PluginHttpRequest,
  type QueueItemDto,
} from '../src/seams/http-routes';
import { IndexerNotFoundError } from '../src/indexers/types';
import { DownloadClientNotFoundError } from '../src/download-clients/types';
import type { DownloadClientDriver } from '../src/download-clients/contract';
import type { DownloadClientRow, DownloadHistoryRow } from '../src/db/rows';
import { CONFIG_PAGES } from '../scripts/manifest-template';

function historyRow(over: Partial<DownloadHistoryRow> = {}): DownloadHistoryRow {
  return {
    id: 1,
    sourceTitle: 'A Title',
    quality: '1080p',
    language: null,
    torrentHash: null,
    status: 'grabbed',
    statusMessage: null,
    grabSource: 'auto',
    mediaId: null,
    episodeId: null,
    seasonId: null,
    indexerId: null,
    downloadClientId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function clientRow(over: Partial<DownloadClientRow> = {}): DownloadClientRow {
  return {
    id: 1,
    name: 'qbit',
    implementation: 'qbittorrent',
    settings: {},
    enabled: true,
    priority: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function fakeDeps(over: Partial<RouteDeps> = {}): RouteDeps {
  return {
    indexerService: {
      findAll: async () => [],
      create: async (input: unknown) => ({ id: 1, ...(input as object) }),
      update: async (id: number, patch: unknown) => ({ id, ...(patch as object) }),
      remove: async () => {},
      testConnection: async () => ({ ok: true, messageKey: 'download.indexers.test.ok' as const }),
      clearCooldown: async () => ({ cleared: true }),
      clearAllCooldowns: () => ({ cleared: 0 }),
    },
    downloadClientsService: {
      findAll: async () => [],
      create: async (input: unknown) => ({ id: 1, ...(input as object) }),
      update: async (id: number, patch: unknown) => ({ id, ...(patch as object) }),
      remove: async () => {},
      testConnection: async () => ({ ok: true, messageKey: 'download.download_clients.test.ok' as const }),
    },
    grabPipeline: {
      searchReleases: async (mediaId: number, seasonId?: number, episodeId?: number) => [{ probe: 'releases', mediaId, seasonId, episodeId }],
      grabRelease: async (mediaId: number) => ({ torrentHash: `hash-${mediaId}` }),
    },
    indexerStats: { dailyStats: async () => [] },
    blocklist: {
      list: async () => ({ items: [], total: 0 }),
      findById: async () => null,
      remove: async () => {},
      clear: async () => {},
    },
    downloadHistory: { findByStatuses: async () => [] },
    downloadClientsRepo: { listEnabled: async () => [] },
    downloadClientDrivers: {},
    host: { call: async () => ({}) },
    ...over,
  } as unknown as RouteDeps;
}

function req(over: Partial<PluginHttpRequest> = {}): PluginHttpRequest {
  return { method: 'GET', path: '/x', query: {}, body: null, principal: { kind: 'system' }, ...over };
}

describe('route table — shape matching', () => {
  test('a ".." segment where a numeric id is expected still matches the route shape', () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('GET', '/../releases');
    assert.ok(resolved, 'one segment, whatever its content, still satisfies /:id/releases');
    assert.equal(resolved!.params['id'], '..');
  });

  test('".." is then rejected by the handler\'s own param validation, not treated as a path', async () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('GET', '/../releases')!;
    const res = await resolved.handler(req({ path: '/../releases' }), resolved.params);
    assert.equal(res.status, 400);
  });

  test('%2F inside a param decodes to a literal slash — still one param, never a second segment', () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('GET', '/1%2F2/releases');
    assert.ok(resolved, 'the raw string is split on "/" before any decoding, so %2F never creates an extra segment');
    assert.equal(resolved!.params['id'], '1/2');
  });

  test('the decoded %2F value then fails the numeric-id check', async () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('GET', '/1%2F2/releases')!;
    const res = await resolved.handler(req({ path: '/1%2F2/releases' }), resolved.params);
    assert.equal(res.status, 400);
  });

  test('a lowercase method does not match — method comparison is case-sensitive', () => {
    const table = createRouteTable(fakeDeps());
    assert.equal(table.resolve('get', '/1/releases'), null);
  });

  test('a wrong-case literal segment does not match — path comparison is case-sensitive', () => {
    const table = createRouteTable(fakeDeps());
    assert.equal(table.resolve('GET', '/1/Releases'), null);
  });

  test('an unrecognised path 404s (resolves to null) rather than falling through to a handler', () => {
    const table = createRouteTable(fakeDeps());
    assert.equal(table.resolve('GET', '/nonexistent'), null);
  });

  test('a declared-but-unbacked route (delay-profiles) also resolves to null', () => {
    const table = createRouteTable(fakeDeps());
    assert.equal(table.resolve('GET', '/delay-profiles'), null);
  });

  test('a season/episode id with no core objectGuard is still validated by the handler', async () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('GET', '/1/seasons/../releases')!;
    assert.ok(resolved);
    assert.equal(resolved.params['seasonId'], '..');
    const res = await resolved.handler(req({ path: '/1/seasons/../releases' }), resolved.params);
    assert.equal(res.status, 400);
  });

  test('every implemented manifest route resolves; the unbacked one does not', () => {
    const table = createRouteTable(fakeDeps());
    const unimplemented = new Set(['GET /delay-profiles']);
    for (const r of ROUTES) {
      const key = `${r.method} ${r.path}`;
      const sample = r.path.replace(/:[a-zA-Z]+/g, '1');
      const resolved = table.resolve(r.method, sample);
      if (unimplemented.has(key)) {
        assert.equal(resolved, null, `${key} has no backing data source in this plugin`);
      } else {
        assert.ok(resolved, `${key} must resolve`);
      }
    }
  });

  test('a POST grab with a manual downloadUrl in the body threads it through to grabRelease', async () => {
    const seen: unknown[] = [];
    const deps: RouteDeps = {
      ...fakeDeps(),
      grabPipeline: {
        searchReleases: fakeDeps().grabPipeline.searchReleases,
        grabRelease: async (mediaId, seasonId, episodeId, manual) => {
          seen.push({ mediaId, seasonId, episodeId, manual });
          return { torrentHash: 'x' };
        },
      },
    };
    const table = createRouteTable(deps);
    const resolved = table.resolve('POST', '/5/grab')!;
    const res = await resolved.handler(
      req({ method: 'POST', path: '/5/grab', body: { downloadUrl: 'magnet:?xt=x', sourceTitle: 'A Title' } }),
      resolved.params,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [{ mediaId: 5, seasonId: undefined, episodeId: undefined, manual: { downloadUrl: 'magnet:?xt=x', sourceTitle: 'A Title', indexerId: undefined } }]);
  });
});

describe('route table — manifest/handler parity', () => {
  // Declared in ROUTES with no handler in this plugin — see canonicalRoutes()'s own comment.
  const DECLARED_BUT_UNBACKED = new Set(['GET /delay-profiles']);

  test('every handler key matches manifest ROUTES[], in both directions', () => {
    const manifestKeys = new Set(
      ROUTES.map((r) => `${r.method} ${r.path}`).filter((k) => !DECLARED_BUT_UNBACKED.has(k)),
    );
    const handlerKeys = new Set(canonicalRoutes(fakeDeps()).map((r) => `${r.method} ${r.path}`));

    for (const key of manifestKeys) {
      assert.ok(handlerKeys.has(key), `manifest declares "${key}" but no handler backs it (core would authorise then 404)`);
    }
    for (const key of handlerKeys) {
      assert.ok(manifestKeys.has(key), `handler backs "${key}" but the manifest never declares it (unreachable — core never authorises it)`);
    }
  });
});

/** Loose superset of the three `ConfigPage` shapes — this plugin has no import access to
 *  the real `ui-contribution.ts` contract type, and the test only needs the route-bearing
 *  fields, not the full discriminated union. */
interface ConfigPageLike {
  id: string;
  kind?: 'providers' | 'table';
  list?: string;
  implementations?: string;
  testConnection?: { route: string };
  actions?: { id: string; method: string; route: string }[];
  listActions?: { method: string; path: string }[];
}

function resolves(table: ReturnType<typeof createRouteTable>, method: string, path: string): boolean {
  return table.resolve(method, path.replace(/:[a-zA-Z]+/g, '1')) !== null;
}

describe('route table — config pages reference only declared, handled routes', () => {
  test('every providers/table page\'s list, implementations and action routes resolve to a real handler', () => {
    const table = createRouteTable(fakeDeps());
    let providersPagesChecked = 0;
    let tablePagesChecked = 0;

    for (const page of CONFIG_PAGES as unknown as ConfigPageLike[]) {
      if (page.kind === 'providers') {
        providersPagesChecked++;
        assert.ok(page.list, `${page.id}: a providers page must declare "list"`);
        assert.ok(resolves(table, 'GET', page.list!), `${page.id}: list route "${page.list}" must resolve`);
        assert.ok(page.implementations, `${page.id}: a providers page must declare "implementations"`);
        assert.ok(
          resolves(table, 'GET', page.implementations!),
          `${page.id}: implementations route "${page.implementations}" must resolve`,
        );
        assert.ok(page.testConnection, `${page.id}: a providers page must declare "testConnection"`);
        assert.ok(
          resolves(table, 'POST', page.testConnection!.route),
          `${page.id}: testConnection route "${page.testConnection!.route}" must resolve`,
        );
        for (const action of page.actions ?? []) {
          assert.ok(
            resolves(table, action.method, action.route),
            `${page.id}: action "${action.id}" route "${action.route}" must resolve`,
          );
        }
      }
      if (page.kind === 'table') {
        tablePagesChecked++;
        assert.ok(page.list, `${page.id}: a table page must declare "list"`);
        assert.ok(resolves(table, 'GET', page.list!), `${page.id}: list route "${page.list}" must resolve`);
        for (const la of page.listActions ?? []) {
          assert.ok(resolves(table, la.method, la.path), `${page.id}: listAction route "${la.path}" must resolve`);
        }
      }
    }

    assert.equal(providersPagesChecked, 2, 'indexers and download-clients');
    assert.equal(tablePagesChecked, 1, 'queue');
  });
});

describe('route table — literal segments win over same-length :id patterns', () => {
  test('DELETE /indexers/cooldowns matches the literal route, not /indexers/:id', () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('DELETE', '/indexers/cooldowns')!;
    assert.ok(resolved);
    assert.deepEqual(resolved.params, {}, 'the literal route carries no "id" param');
  });

  test('DELETE /indexers/42 still resolves to the :id route', () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('DELETE', '/indexers/42')!;
    assert.ok(resolved);
    assert.deepEqual(resolved.params, { id: '42' });
  });

  test('DELETE /blocklist/all matches the literal route, not /blocklist/:id', () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('DELETE', '/blocklist/all')!;
    assert.ok(resolved);
    assert.deepEqual(resolved.params, {});
  });

  test('DELETE /blocklist/7 still resolves to the :id route', () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('DELETE', '/blocklist/7')!;
    assert.ok(resolved);
    assert.deepEqual(resolved.params, { id: '7' });
  });

  test('GET /indexers/implementations matches the literal route, not /indexers/:id', () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('GET', '/indexers/implementations')!;
    assert.ok(resolved);
    assert.deepEqual(resolved.params, {});
  });

  test('GET /indexers/42/stats still resolves to the :id route', () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('GET', '/indexers/42/stats')!;
    assert.ok(resolved);
    assert.deepEqual(resolved.params, { id: '42' });
  });

  test('GET /download-clients/implementations matches the literal route, not /download-clients/:id', async () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('GET', '/download-clients/implementations')!;
    assert.ok(resolved);
    assert.deepEqual(resolved.params, {});
    const res = await resolved.handler(req({ path: '/download-clients/implementations' }), resolved.params);
    assert.equal(res.status, 200, 'a numeric-looking id would 200 via the update handler instead — proves the literal won');
  });

  test('PUT /download-clients/42 still resolves to the :id route', () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('PUT', '/download-clients/42')!;
    assert.ok(resolved);
    assert.deepEqual(resolved.params, { id: '42' });
  });
});

describe('route table — GET /queue', () => {
  test('no in-flight rows and no enabled clients: an honest empty page, not flagged unreachable', async () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue' }), resolved.params);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { data: [], total: 0, page: 1, pageSize: 25, clientsUnreachable: false });
  });

  test('an "importing" row reports state=importing and full progress regardless of any client', async () => {
    const deps = fakeDeps({
      downloadHistory: { findByStatuses: async () => [historyRow({ id: 9, status: 'importing' })] },
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue' }), resolved.params);
    const body = res.body as { data: QueueItemDto[] };
    assert.deepEqual(body.data, [
      {
        id: 9,
        title: 'A Title',
        quality: '1080p',
        state: 'importing',
        progress: 1,
        bytesPerSecond: null,
        clientReachable: true,
        mediaId: null,
        mediaType: null,
      },
    ]);
  });

  test('a grabbed row matched to a live torrent maps the client\'s own state through the closed vocabulary', async () => {
    const driver: DownloadClientDriver = {
      supports: (c) => c.enabled,
      testConnection: async () => ({ ok: true, messageKey: 'download.download_clients.test.ok' }),
      getTorrents: async () => [],
      getTorrentsResult: async () => ({
        ok: true,
        torrents: [
          {
            hash: 'ABCD',
            name: 'x',
            size: 1000,
            downloaded: 500,
            progress: 0.5,
            dlspeed: 12345,
            upspeed: 0,
            ratio: 0,
            eta: 60,
            state: 'stalledDL', // client vocabulary — never surfaced raw
            category: '',
            num_seeds: 0,
            num_leechs: 0,
            added_on: 0,
          },
        ],
      }),
      getTorrentFiles: async () => [],
      addTorrentUrl: async () => 'x',
      deleteTorrent: async () => {},
    };
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [historyRow({ id: 3, torrentHash: 'abcd', downloadClientId: 1 })],
      },
      downloadClientsRepo: { listEnabled: async () => [clientRow({ id: 1 })] },
      downloadClientDrivers: { qbittorrent: driver },
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue' }), resolved.params);
    const body = res.body as { data: QueueItemDto[]; clientsUnreachable: boolean };
    assert.deepEqual(body.data, [
      {
        id: 3,
        title: 'A Title',
        quality: '1080p',
        state: 'stalled',
        progress: 0.5,
        bytesPerSecond: 12345,
        clientReachable: true,
        mediaId: null,
        mediaType: null,
      },
    ]);
    assert.equal(body.clientsUnreachable, false);
  });

  test('an unreachable client: clientsUnreachable is set, and its rows report unknown progress rather than empty/zero', async () => {
    const driver: DownloadClientDriver = {
      supports: (c) => c.enabled,
      testConnection: async () => ({ ok: true, messageKey: 'download.download_clients.test.ok' }),
      getTorrents: async () => [],
      getTorrentsResult: async () => ({ ok: false, torrents: [] }),
      getTorrentFiles: async () => [],
      addTorrentUrl: async () => 'x',
      deleteTorrent: async () => {},
    };
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [historyRow({ id: 5, torrentHash: 'abcd', downloadClientId: 1 })],
      },
      downloadClientsRepo: { listEnabled: async () => [clientRow({ id: 1 })] },
      downloadClientDrivers: { qbittorrent: driver },
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue' }), resolved.params);
    const body = res.body as { data: QueueItemDto[]; total: number; clientsUnreachable: boolean };
    assert.equal(body.clientsUnreachable, true, 'the response must say the client could not be reached');
    assert.equal(body.total, 1, 'the row still shows — it is not silently dropped to an empty page');
    assert.deepEqual(body.data[0], {
      id: 5,
      title: 'A Title',
      quality: '1080p',
      state: 'queued',
      progress: null,
      bytesPerSecond: null,
      clientReachable: false,
      mediaId: null,
      mediaType: null,
    });
  });

  test('pagination: page/pageSize are read from the query and total reflects the unpaged count', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => historyRow({ id: i + 1 }));
    const deps = fakeDeps({ downloadHistory: { findByStatuses: async () => rows } });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue', query: { page: '2', pageSize: '2' } }), resolved.params);
    const body = res.body as { data: QueueItemDto[]; total: number; page: number; pageSize: number };
    assert.equal(body.total, 3);
    assert.equal(body.page, 2);
    assert.equal(body.pageSize, 2);
    assert.deepEqual(body.data.map((i) => i.id), [1], 'newest (id 3, 2) on page 1; id 1 is the lone item on page 2');
  });

  test('a row with a resolvable media gets both fields; one whose media is missing gets neither', async () => {
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [historyRow({ id: 1, mediaId: 42 }), historyRow({ id: 2, mediaId: null })],
      },
      host: {
        call: async (_method: string, payload: unknown) => {
          const { mediaIds } = payload as { mediaIds: number[] };
          const out: Record<string, { title: string; kind: string; libraryId: number }> = {};
          if (mediaIds.includes(42)) out['media:42'] = { title: 'X', kind: 'series', libraryId: 1 };
          return out;
        },
      } as unknown as RouteDeps['host'],
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue' }), resolved.params);
    const body = res.body as { data: QueueItemDto[] };
    const withMedia = body.data.find((i) => i.id === 1);
    const withoutMedia = body.data.find((i) => i.id === 2);
    assert.deepEqual({ mediaId: withMedia!.mediaId, mediaType: withMedia!.mediaType }, { mediaId: 42, mediaType: 'series' });
    assert.deepEqual({ mediaId: withoutMedia!.mediaId, mediaType: withoutMedia!.mediaType }, { mediaId: null, mediaType: null });
  });

  test('a mediaId present but absent from the resolve reply (deleted/unknown media) still gets no button', async () => {
    const deps = fakeDeps({
      downloadHistory: { findByStatuses: async () => [historyRow({ id: 1, mediaId: 99 })] },
      host: { call: async () => ({}) } as unknown as RouteDeps['host'], // core found nothing for id 99
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue' }), resolved.params);
    const body = res.body as { data: QueueItemDto[] };
    assert.deepEqual({ mediaId: body.data[0]!.mediaId, mediaType: body.data[0]!.mediaType }, { mediaId: 99, mediaType: null });
  });

  test('media.resolve is called once, bounded to the current page\'s mediaIds — never the full history', async () => {
    const rows = Array.from({ length: 130 }, (_, i) => historyRow({ id: i + 1, mediaId: i + 1 }));
    const calls: { method: string; payload: unknown }[] = [];
    const deps = fakeDeps({
      downloadHistory: { findByStatuses: async () => rows },
      host: {
        call: async (method: string, payload: unknown) => {
          calls.push({ method, payload });
          return {};
        },
      } as unknown as RouteDeps['host'],
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue', query: { page: '1', pageSize: '25' } }), resolved.params);
    const body = res.body as { total: number };
    assert.equal(body.total, 130, 'the full (unpaged) count is still reported');

    const resolveCalls = calls.filter((c) => c.method === 'media.resolve');
    assert.equal(resolveCalls.length, 1, 'media.resolve must be called exactly once per queue page, not once per row');
    const { mediaIds } = resolveCalls[0]!.payload as { mediaIds: number[] };
    assert.ok(mediaIds.length <= 25, `must never exceed the page size (got ${mediaIds.length}, would throw above 100)`);
    assert.deepEqual(
      [...mediaIds].sort((a, b) => a - b),
      Array.from({ length: 25 }, (_, i) => 106 + i),
      'only the ids of the rendered page (rows sorted newest-first, page 1 of 130) — never the other 105',
    );
  });
});

describe('route table — implementations routes', () => {
  test('GET /indexers/implementations answers a list with one entry, "torznab", and its fields', async () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('GET', '/indexers/implementations')!;
    const res = await resolved.handler(req({ path: '/indexers/implementations' }), resolved.params);
    assert.equal(res.status, 200);
    const body = res.body as { implementation: string; labelKey: string; fields: { key: string }[] }[];
    assert.ok(Array.isArray(body), 'the shape must still be a list, even with one implementation');
    assert.equal(body.length, 1);
    assert.equal(body[0]!.implementation, 'torznab');
    assert.deepEqual(
      body[0]!.fields.map((f) => f.key).sort(),
      ['apiKey', 'baseUrl', 'enableSearch', 'minSeeders', 'requestDelay', 'seedRatio', 'unknownLanguageIsoCode'],
    );
  });

  test('GET /download-clients/implementations answers a list with one entry, "qbittorrent", and its fields', async () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('GET', '/download-clients/implementations')!;
    const res = await resolved.handler(req({ path: '/download-clients/implementations' }), resolved.params);
    assert.equal(res.status, 200);
    const body = res.body as { implementation: string; fields: { key: string }[] }[];
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 1);
    assert.equal(body[0]!.implementation, 'qbittorrent');
    assert.deepEqual(
      body[0]!.fields.map((f) => f.key).sort(),
      ['category', 'host', 'movieCategory', 'password', 'port', 'seriesCategory', 'useSsl', 'username'],
    );
  });
});

describe('route table — admin write handlers', () => {
  test('POST /indexers with no name is a 400 naming the field, and never reaches the service', async () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('POST', '/indexers')!;
    const res = await resolved.handler(req({ method: 'POST', path: '/indexers', body: { implementation: 'torznab' } }), resolved.params);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: { key: 'download.http.errors.bad_body', detail: 'name' } });
  });

  test('POST /indexers with a name and implementation creates, status 201', async () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('POST', '/indexers')!;
    const res = await resolved.handler(
      req({ method: 'POST', path: '/indexers', body: { name: 'X', implementation: 'torznab', settings: { apiKey: 'k' } } }),
      resolved.params,
    );
    assert.equal(res.status, 201);
  });

  test('DELETE /indexers/:id maps IndexerNotFoundError to a 404 with the not_found key', async () => {
    const deps = fakeDeps();
    deps.indexerService.remove = async () => {
      throw new IndexerNotFoundError('Indexer #9 not found');
    };
    const table = createRouteTable(deps);
    const resolved = table.resolve('DELETE', '/indexers/9')!;
    const res = await resolved.handler(req({ method: 'DELETE', path: '/indexers/9' }), resolved.params);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: { key: 'download.http.errors.not_found', detail: 'Indexer #9 not found' } });
  });

  test('DELETE /download-clients/:id maps DownloadClientNotFoundError to a 404', async () => {
    const deps = fakeDeps();
    deps.downloadClientsService.remove = async () => {
      throw new DownloadClientNotFoundError('Download client #3 not found');
    };
    const table = createRouteTable(deps);
    const resolved = table.resolve('DELETE', '/download-clients/3')!;
    const res = await resolved.handler(req({ method: 'DELETE', path: '/download-clients/3' }), resolved.params);
    assert.equal(res.status, 404);
  });

  test('DELETE /blocklist/:id 404s inline when the row is missing, without calling remove()', async () => {
    const deps = fakeDeps();
    let removeCalled = false;
    deps.blocklist.remove = async () => void (removeCalled = true);
    const table = createRouteTable(deps);
    const resolved = table.resolve('DELETE', '/blocklist/123')!;
    const res = await resolved.handler(req({ method: 'DELETE', path: '/blocklist/123' }), resolved.params);
    assert.equal(res.status, 404);
    assert.equal(removeCalled, false);
  });

  test('GET /blocklist maps the repository page shape to {data, total, page, pageSize}', async () => {
    const deps = fakeDeps();
    deps.blocklist.list = async (limit: number, offset: number) => {
      assert.equal(limit, 20);
      assert.equal(offset, 20); // page 2
      return { items: [{ id: 1 }] as never, total: 21 };
    };
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/blocklist')!;
    const res = await resolved.handler(req({ method: 'GET', path: '/blocklist', query: { page: '2', pageSize: '20' } }), resolved.params);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { data: [{ id: 1 }], total: 21, page: 2, pageSize: 20 });
  });

  test('POST /download-clients/test-connection with a non-string implementation is a 400', async () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('POST', '/download-clients/test-connection')!;
    const res = await resolved.handler(req({ method: 'POST', path: '/download-clients/test-connection', body: {} }), resolved.params);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: { key: 'download.http.errors.bad_body', detail: 'implementation' } });
  });
});

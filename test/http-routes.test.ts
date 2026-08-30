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
import { DownloadClientHttpError, DownloadClientNotFoundError, DownloadClientUnreachableError } from '../src/download-clients/types';
import type { DownloadClientDriver } from '../src/download-clients/contract';
import type { DownloadClientRow, DownloadHistoryRow, DownloadHistoryStatus } from '../src/db/rows';
import { CONFIG_PAGES } from '../scripts/manifest-template';

function historyRow(over: Partial<DownloadHistoryRow> = {}): DownloadHistoryRow {
  return {
    id: 1,
    sourceTitle: 'A Title',
    quality: '1080p',
    language: null,
    torrentHash: null,
    size: null,
    infoUrl: null,
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

/** Each dep is itself partial: a test overriding one repository method should not have to
 *  restate the five it does not care about. */
function fakeDeps(over: { [K in keyof RouteDeps]?: Partial<RouteDeps[K]> } = {}): RouteDeps {
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
      pauseTorrent: async () => {},
      resumeTorrent: async () => {},
      removeTorrent: async () => {},
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
    downloadHistory: {
      findByStatuses: async () => [],
      listPage: async () => ({ rows: [], total: 0 }),
      findById: async () => null,
      remove: async () => {},
      clearTerminal: async () => 0,
      markFailed: async () => {},
    },
    downloadClientsRepo: { listEnabled: async () => [] },
    downloadClientDrivers: {},
    settleAndPublish: async () => {},
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
    assert.deepEqual(seen, [{ mediaId: 5, seasonId: undefined, episodeId: undefined, manual: { downloadUrl: 'magnet:?xt=x', sourceTitle: 'A Title', indexerId: undefined, infoUrl: undefined, force: false } }]);
  });

  test('a POST grab body with force: true threads force through to grabRelease', async () => {
    const seen: unknown[] = [];
    const deps: RouteDeps = {
      ...fakeDeps(),
      grabPipeline: {
        searchReleases: fakeDeps().grabPipeline.searchReleases,
        grabRelease: async (mediaId, seasonId, episodeId, manual) => {
          seen.push(manual);
          return { torrentHash: 'x' };
        },
      },
    };
    const table = createRouteTable(deps);
    const resolved = table.resolve('POST', '/5/grab')!;
    await resolved.handler(req({ method: 'POST', path: '/5/grab', body: { downloadUrl: 'magnet:?xt=x', force: true } }), resolved.params);
    assert.deepEqual(seen, [{ downloadUrl: 'magnet:?xt=x', sourceTitle: undefined, indexerId: undefined, infoUrl: undefined, force: true }]);
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
    assert.equal(tablePagesChecked, 2, 'queue and history');
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
      downloadHistory: {
        findByStatuses: async () => [historyRow({ id: 9, status: 'importing', indexerId: 7 })],
        listPage: async () => ({ rows: [], total: 0 }),
      },
      indexerService: { ...fakeDeps().indexerService, findAll: async () => [{ id: 7, name: 'Tracker A' }] as never },
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue' }), resolved.params);
    const body = res.body as { data: QueueItemDto[] };
    assert.deepEqual(body.data, [
      {
        id: 9,
        title: 'A Title',
        sourceTitle: 'A Title',
        quality: '1080p',
        grabSource: 'auto',
        date: '2026-01-01T00:00:00.000Z',
        infoUrl: null,
        source: 'Tracker A',
        state: 'importing',
        progress: 100,
        bytesPerSecond: null,
        size: null,
        clientReachable: true,
        mediaId: null,
        seasonId: null,
        episodeId: null,
        mediaType: null,
      },
    ]);
  });

  /**
   * Deleting a torrent from the client left its row sitting in the queue as
   * "queued" — with no size, progress or speed — until the orphan sweep's grace
   * expired minutes later. A client that answered and does not hold the torrent
   * is proof it is gone; one that did not answer proves nothing.
   */
  test('VERDICT: a row whose reachable client no longer holds its torrent leaves the queue', async () => {
    const driver: DownloadClientDriver = {
      supports: (c) => c.enabled,
      testConnection: async () => ({ ok: true, messageKey: 'download.download_clients.test.ok' }),
      getTorrents: async () => [],
      getTorrentsResult: async () => ({ ok: true, torrents: [] }),
      getTorrentFilesResult: async () => ({ ok: true, files: [] }),
      addTorrentUrl: async () => 'x',
      deleteTorrent: async () => {},
      pauseTorrent: async () => {},
      resumeTorrent: async () => {},
    };
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [historyRow({ id: 3, torrentHash: 'abcd', downloadClientId: 1 })],
        listPage: async () => ({ rows: [], total: 0 }),
      },
      downloadClientsRepo: { listEnabled: async () => [clientRow({ id: 1 })] },
      downloadClientDrivers: { qbittorrent: driver },
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue' }), resolved.params);
    const body = res.body as { data: QueueItemDto[]; total: number; clientsUnreachable: boolean };

    assert.deepEqual(body.data, []);
    assert.equal(body.total, 0);
    assert.equal(body.clientsUnreachable, false, 'the client answered — the row is gone, not hidden behind an outage');
  });

  test('the same row stays when its client could not be reached', async () => {
    const driver: DownloadClientDriver = {
      supports: (c) => c.enabled,
      testConnection: async () => ({ ok: false, messageKey: 'download.download_clients.test.ok' }),
      getTorrents: async () => [],
      getTorrentsResult: async () => ({ ok: false, torrents: [] }),
      getTorrentFilesResult: async () => ({ ok: false, files: [] }),
      addTorrentUrl: async () => 'x',
      deleteTorrent: async () => {},
      pauseTorrent: async () => {},
      resumeTorrent: async () => {},
    };
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [historyRow({ id: 3, torrentHash: 'abcd', downloadClientId: 1 })],
        listPage: async () => ({ rows: [], total: 0 }),
      },
      downloadClientsRepo: { listEnabled: async () => [clientRow({ id: 1 })] },
      downloadClientDrivers: { qbittorrent: driver },
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue' }), resolved.params);
    const body = res.body as { data: QueueItemDto[]; clientsUnreachable: boolean };

    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]!.clientReachable, false);
    assert.equal(body.clientsUnreachable, true);
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
      getTorrentFilesResult: async () => ({ ok: true, files: [] }),
      addTorrentUrl: async () => 'x',
      deleteTorrent: async () => {},
      pauseTorrent: async () => {},
      resumeTorrent: async () => {},
    };
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [historyRow({ id: 3, torrentHash: 'abcd', downloadClientId: 1 })],
        listPage: async () => ({ rows: [], total: 0 }),
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
        sourceTitle: 'A Title',
        quality: '1080p',
        grabSource: 'auto',
        date: '2026-01-01T00:00:00.000Z',
        infoUrl: null,
        source: '',
        state: 'stalled',
        // The client reports 0.5; the table renders this verbatim, so it must be a percent.
        progress: 50,
        bytesPerSecond: 12345,
        size: 1000,
        clientReachable: true,
        mediaId: null,
        seasonId: null,
        episodeId: null,
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
      getTorrentFilesResult: async () => ({ ok: true, files: [] }),
      addTorrentUrl: async () => 'x',
      deleteTorrent: async () => {},
      pauseTorrent: async () => {},
      resumeTorrent: async () => {},
    };
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [historyRow({ id: 5, torrentHash: 'abcd', downloadClientId: 1 })],
        listPage: async () => ({ rows: [], total: 0 }),
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
      sourceTitle: 'A Title',
      quality: '1080p',
      grabSource: 'auto',
      date: '2026-01-01T00:00:00.000Z',
      infoUrl: null,
      source: '',
      state: 'queued',
      progress: null,
      bytesPerSecond: null,
      size: null,
      clientReachable: false,
      mediaId: null,
      seasonId: null,
      episodeId: null,
      mediaType: null,
    });
  });

  test('pagination: page/pageSize are read from the query and total reflects the unpaged count', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => historyRow({ id: i + 1 }));
    const deps = fakeDeps({ downloadHistory: { findByStatuses: async () => rows, listPage: async () => ({ rows, total: rows.length }) } });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue', query: { page: '2', pageSize: '2' } }), resolved.params);
    const body = res.body as { data: QueueItemDto[]; total: number; page: number; pageSize: number };
    assert.equal(body.total, 3);
    assert.equal(body.page, 2);
    assert.equal(body.pageSize, 2);
    assert.deepEqual(body.data.map((i) => i.id), [1], 'newest (id 3, 2) on page 1; id 1 is the lone item on page 2');
  });

  test('pagination: a pageSize past the resolvable ceiling is clamped, not answered half-labelled', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => historyRow({ id: i + 1 }));
    const deps = fakeDeps({ downloadHistory: { findByStatuses: async () => rows, listPage: async () => ({ rows, total: rows.length }) } });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue', query: { page: '1', pageSize: '500' } }), resolved.params);
    const body = res.body as { data: QueueItemDto[]; pageSize: number };
    // 100 is core's media.resolve bound: one id per row, and it refuses more than that.
    assert.equal(body.pageSize, 100);
    assert.equal(body.data.length, 100);
  });

  test('a row with a resolvable media gets both fields; one whose media is missing gets neither', async () => {
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [historyRow({ id: 1, mediaId: 42 }), historyRow({ id: 2, mediaId: null })],
        listPage: async () => ({ rows: [], total: 0 }),
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
      downloadHistory: { findByStatuses: async () => [historyRow({ id: 1, mediaId: 99 })], listPage: async () => ({ rows: [], total: 0 }) },
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
      downloadHistory: { findByStatuses: async () => rows, listPage: async () => ({ rows, total: rows.length }) },
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
      ['apiKey', 'baseUrl', 'enableSearch', 'maxRetentionDays', 'minSeeders', 'requestDelay', 'seedRatio', 'unknownLanguageIsoCode'],
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

describe('route table — download history', () => {
  test('VERDICT: answers every status newest-first, so a failed grab is still readable', async () => {
    const rows = [
      historyRow({ id: 2, status: 'failed', statusMessage: 'no file could be placed', sourceTitle: 'B', indexerId: 7 }),
      historyRow({ id: 1, status: 'completed', sourceTitle: 'A' }),
    ];
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [],
        listPage: async () => ({ rows, total: 2 }),
      },
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/history')!;
    const res = await resolved.handler(req({ path: '/history' }), resolved.params);

    assert.equal(res.status, 200);
    const body = res.body as { data: Record<string, unknown>[]; total: number };
    assert.equal(body.total, 2);
    // The queue filters to grabbed/importing; a history that did the same would be the same page.
    assert.deepEqual(
      body.data.map((r) => [r['status'], r['title']]),
      [['failed', 'B'], ['completed', 'A']],
    );
    assert.equal(body.data[0]!['statusMessage'], 'no file could be placed');
    assert.ok('date' in body.data[0]!, 'the column the page sorts and formats on must be present');
  });

  test('page and pageSize reach the repository as limit/offset, capped', async () => {
    const seen: { limit: number; offset: number }[] = [];
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [],
        listPage: async (limit: number, offset: number) => {
          seen.push({ limit, offset });
          return { rows: [], total: 0 };
        },
      },
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/history')!;
    await resolved.handler(req({ path: '/history', query: { page: '3', pageSize: '5000' } }), resolved.params);

    // An unbounded pageSize would read the whole append-only table into memory.
    assert.deepEqual(seen, [{ limit: 100, offset: 200 }]);
  });

  test('q and a recognised status reach the repository, q trimmed', async () => {
    const seen: ({ q?: string; status?: DownloadHistoryStatus } | undefined)[] = [];
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [],
        listPage: async (_limit: number, _offset: number, filter?: { q?: string; status?: DownloadHistoryStatus }) => {
          seen.push(filter);
          return { rows: [], total: 0 };
        },
      },
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/history')!;
    await resolved.handler(req({ path: '/history', query: { q: '  some.title  ', status: 'failed' } }), resolved.params);
    assert.deepEqual(seen, [{ q: 'some.title', status: 'failed' }]);
  });

  test('a blank q and an unrecognised status are both dropped before reaching the repository', async () => {
    const seen: ({ q?: string; status?: DownloadHistoryStatus } | undefined)[] = [];
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [],
        listPage: async (_limit: number, _offset: number, filter?: { q?: string; status?: DownloadHistoryStatus }) => {
          seen.push(filter);
          return { rows: [], total: 0 };
        },
      },
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/history')!;
    // "deleted" is not a member of DownloadHistoryStatus — never interpolated, never applied.
    await resolved.handler(req({ path: '/history', query: { q: '   ', status: 'deleted' } }), resolved.params);
    assert.deepEqual(seen, [{}], 'an unrecognised status must be dropped, not forwarded to the repository');
  });

  test('no q/status in the request forwards no filter keys at all', async () => {
    const seen: ({ q?: string; status?: DownloadHistoryStatus } | undefined)[] = [];
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [],
        listPage: async (_limit: number, _offset: number, filter?: { q?: string; status?: DownloadHistoryStatus }) => {
          seen.push(filter);
          return { rows: [], total: 0 };
        },
      },
    });
    const table = createRouteTable(deps);
    const resolved = table.resolve('GET', '/history')!;
    await resolved.handler(req({ path: '/history' }), resolved.params);
    assert.deepEqual(seen, [{}]);
  });
});

describe('queue controls', () => {
  const live = () => historyRow({ id: 3, status: 'grabbed', torrentHash: 'abcd', downloadClientId: 1 });

  function controlDeps(row: DownloadHistoryRow | null) {
    const calls: { fn: string; args: unknown[] }[] = [];
    const failed: { id: number; message: string }[] = [];
    const deps = fakeDeps({
      downloadHistory: {
        findById: async () => row,
        markFailed: async (id: number, message: string) => {
          failed.push({ id, message });
        },
      },
      downloadClientsService: {
        pauseTorrent: async (...args: unknown[]) => {
          calls.push({ fn: 'pause', args });
        },
        resumeTorrent: async (...args: unknown[]) => {
          calls.push({ fn: 'resume', args });
        },
        removeTorrent: async (...args: unknown[]) => {
          calls.push({ fn: 'remove', args });
        },
      } as unknown as RouteDeps['downloadClientsService'],
    });
    return { deps, calls, failed };
  }

  async function run(deps: RouteDeps, method: string, path: string, query: Record<string, string> = {}) {
    const resolved = createRouteTable(deps).resolve(method, path)!;
    assert.ok(resolved, `${method} ${path} did not resolve`);
    return resolved.handler(req({ method, path, query }), resolved.params);
  }

  test('pause reaches the client that holds the row’s torrent', async () => {
    const { deps, calls } = controlDeps(live());
    assert.equal((await run(deps, 'POST', '/queue/3/pause')).status, 200);
    assert.deepEqual(calls, [{ fn: 'pause', args: [1, 'abcd'] }]);
  });

  test('resume is a separate route, not a toggle — a stale row would flip the wrong way', async () => {
    const { deps, calls } = controlDeps(live());
    assert.equal((await run(deps, 'POST', '/queue/3/resume')).status, 200);
    assert.deepEqual(calls, [{ fn: 'resume', args: [1, 'abcd'] }]);
  });

  test('VERDICT: removal forwards the deleteFiles answer, and defaults to keeping them', async () => {
    const { deps, calls } = controlDeps(live());
    await run(deps, 'DELETE', '/queue/3', { deleteFiles: 'true' });
    assert.deepEqual(calls, [{ fn: 'remove', args: [1, 'abcd', true] }]);

    const bare = controlDeps(live());
    await run(bare.deps, 'DELETE', '/queue/3');
    assert.deepEqual(bare.calls, [{ fn: 'remove', args: [1, 'abcd', false] }]);
  });

  test('VERDICT: removal retires the history row, so the removal is readable afterwards', async () => {
    const { deps, failed } = controlDeps(live());
    await run(deps, 'DELETE', '/queue/3');
    assert.deepEqual(failed, [{ id: 3, message: 'download.queue.removed_by_user' }]);
  });

  test('an importing row is refused: its files are already being moved', async () => {
    const { deps, calls } = controlDeps(historyRow({ id: 3, status: 'importing', torrentHash: 'abcd', downloadClientId: 1 }));
    const res = await run(deps, 'POST', '/queue/3/pause');
    assert.equal(res.status, 409);
    assert.deepEqual(calls, []);
  });

  test('a row with no client or hash answers 409, not 404 — the row exists', async () => {
    const { deps } = controlDeps(historyRow({ id: 3, status: 'grabbed' }));
    assert.equal((await run(deps, 'POST', '/queue/3/pause')).status, 409);
  });

  test('an unknown row is a 404', async () => {
    const { deps } = controlDeps(null);
    assert.equal((await run(deps, 'DELETE', '/queue/3')).status, 404);
  });
});

describe('history pruning', () => {
  test('/history/all resolves before /history/:id — the literal segment must win', () => {
    const table = createRouteTable(fakeDeps());
    assert.equal(table.resolve('DELETE', '/history/all')!.params['id'], undefined);
    assert.equal(table.resolve('DELETE', '/history/7')!.params['id'], '7');
  });

  test('deleting one row refuses an id that is not there', async () => {
    const removed: number[] = [];
    const deps = fakeDeps({
      downloadHistory: { findById: async () => null, remove: async (id: number) => void removed.push(id) },
    });
    const resolved = createRouteTable(deps).resolve('DELETE', '/history/7')!;
    assert.equal((await resolved.handler(req({ method: 'DELETE', path: '/history/7' }), resolved.params)).status, 404);
    assert.deepEqual(removed, []);
  });

  test('clearing reports how many rows went', async () => {
    const deps = fakeDeps({ downloadHistory: { clearTerminal: async () => 12 } });
    const resolved = createRouteTable(deps).resolve('DELETE', '/history/all')!;
    const res = await resolved.handler(req({ method: 'DELETE', path: '/history/all' }), resolved.params);
    assert.deepEqual(res.body, { removed: 12 });
  });
});

describe('queue and history row titles', () => {
  /** `media.resolve` answers whatever these keys hold; anything else is an unresolved row. */
  function depsResolving(resolved: Record<string, unknown>, rows: DownloadHistoryRow[]) {
    const payloads: unknown[] = [];
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => rows,
        listPage: async () => ({ rows, total: rows.length }),
      },
      host: {
        call: async (method: string, payload: unknown) => {
          if (method !== 'media.resolve') return {};
          payloads.push(payload);
          return resolved;
        },
      } as unknown as RouteDeps['host'],
    });
    return { deps, payloads };
  }

  async function queueRows(deps: RouteDeps) {
    const resolved = createRouteTable(deps).resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue' }), resolved.params);
    return (res.body as { data: QueueItemDto[] }).data;
  }

  test('a film shows its own title, not the release name', async () => {
    const { deps } = depsResolving({ 'media:5': { title: 'Nova Skyline', kind: 'movie', libraryId: 1 } }, [
      historyRow({ id: 1, mediaId: 5, sourceTitle: 'Nova.Skyline.2012.1080p.WEB-DL.x264-GRP' }),
    ]);
    const [row] = await queueRows(deps);
    assert.equal(row!.title, 'Nova Skyline');
    assert.equal(row!.mediaType, 'movie');
  });

  test('VERDICT: an episode reads "Show - S01E02", zero-padded', async () => {
    const { deps } = depsResolving(
      { 'episode:44': { title: 'Harbour Lights', kind: 'series', libraryId: 1, seasonNumber: 1, episodeNumber: 2 } },
      [historyRow({ id: 1, mediaId: 5, seasonId: 9, episodeId: 44 })],
    );
    assert.equal((await queueRows(deps))[0]!.title, 'Harbour Lights - S01E02');
  });

  test('VERDICT: a season pack reads "Show - S01" — no episode to name', async () => {
    const { deps } = depsResolving(
      { 'season:9': { title: 'Harbour Lights', kind: 'series', libraryId: 1, seasonNumber: 1 } },
      [historyRow({ id: 1, mediaId: 5, seasonId: 9 })],
    );
    assert.equal((await queueRows(deps))[0]!.title, 'Harbour Lights - S01');
  });

  test('VERDICT: one id per row — an episode never also asks for its season and media', async () => {
    const { deps, payloads } = depsResolving({}, [historyRow({ id: 1, mediaId: 5, seasonId: 9, episodeId: 44 })]);
    await queueRows(deps);
    assert.deepEqual(payloads, [{ mediaIds: [], seasonIds: [], episodeIds: [44] }]);
  });

  test('an unresolvable row keeps its release name rather than rendering blank', async () => {
    const { deps } = depsResolving({}, [historyRow({ id: 1, mediaId: 5, sourceTitle: 'Some.Release.1080p' })]);
    const [row] = await queueRows(deps);
    assert.equal(row!.title, 'Some.Release.1080p');
    assert.equal(row!.mediaType, null);
  });

  test('the release name is always kept alongside, for the title cell to open', async () => {
    const { deps } = depsResolving({ 'media:5': { title: 'Nova Skyline', kind: 'movie', libraryId: 1 } }, [
      historyRow({ id: 1, mediaId: 5, sourceTitle: 'Nova.Skyline.2012.1080p' }),
    ]);
    assert.equal((await queueRows(deps))[0]!.sourceTitle, 'Nova.Skyline.2012.1080p');
  });

  test('history labels its rows the same way, from the same resolver', async () => {
    const { deps } = depsResolving(
      { 'episode:44': { title: 'Harbour Lights', kind: 'series', libraryId: 1, seasonNumber: 12, episodeNumber: 7 } },
      [historyRow({ id: 1, status: 'completed', mediaId: 5, seasonId: 9, episodeId: 44 })],
    );
    const resolved = createRouteTable(deps).resolve('GET', '/history')!;
    const res = await resolved.handler(req({ path: '/history' }), resolved.params);
    const data = (res.body as { data: { title: string }[] }).data;
    assert.equal(data[0]!.title, 'Harbour Lights - S12E07');
  });
});

describe('history live state', () => {
  /** One enabled client still holding the torrent, whatever the row's own status says. */
  function depsHolding(row: DownloadHistoryRow) {
    const driver = {
      supports: (c: DownloadClientRow) => c.enabled,
      testConnection: async () => ({ ok: true, messageKey: 'download.download_clients.test.ok' }),
      getTorrents: async () => [],
      getTorrentsResult: async () => ({
        ok: true,
        torrents: [
          {
            hash: 'abcd',
            name: 'x',
            size: 1000,
            downloaded: 500,
            progress: 0.5,
            dlspeed: 1,
            upspeed: 0,
            ratio: 0,
            eta: 60,
            state: 'downloading',
            category: '',
            num_seeds: 1,
            num_leechs: 0,
            added_on: 0,
          },
        ],
      }),
      getTorrentFilesResult: async () => ({ ok: true, files: [] }),
      addTorrentUrl: async () => 'x',
      deleteTorrent: async () => {},
      pauseTorrent: async () => {},
      resumeTorrent: async () => {},
    } as unknown as DownloadClientDriver;
    return fakeDeps({
      downloadHistory: { listPage: async () => ({ rows: [row], total: 1 }) },
      downloadClientsRepo: { listEnabled: async () => [clientRow({ id: 1 })] },
      downloadClientDrivers: { qbittorrent: driver },
    });
  }

  async function historyRowOf(deps: RouteDeps) {
    const resolved = createRouteTable(deps).resolve('GET', '/history')!;
    const res = await resolved.handler(req({ path: '/history' }), resolved.params);
    return (res.body as { data: { state: string | null; progress: number | null }[] }).data[0]!;
  }

  const stateOf = async (status: DownloadHistoryStatus) => {
    const row = historyRow({ id: 1, status, torrentHash: 'abcd', downloadClientId: 1 });
    const item = await historyRowOf(depsHolding(row));
    return { state: item.state, progress: item.progress };
  };

  test('a running row reports what its client says', async () => {
    assert.deepEqual(await stateOf('grabbed'), { state: 'active', progress: 50 });
  });

  test('VERDICT: a terminal row reports no live state, even while its client still holds the torrent', async () => {
    // Seeding on, or left behind by an import that failed. Reporting `active` offered a Pause
    // button on a dead row, for a route that answers 409.
    assert.deepEqual(await stateOf('failed'), { state: null, progress: null });
    assert.deepEqual(await stateOf('completed'), { state: null, progress: null });
  });

  test('an importing row is definitive whatever the client reports', async () => {
    const row = historyRow({ id: 1, status: 'importing', torrentHash: 'abcd', downloadClientId: 1 });
    const item = await historyRowOf(depsHolding(row));
    assert.equal(item.state, 'importing');
    assert.equal(item.progress, 100);
  });
});

describe('an unknown size is not a zero', () => {
  test('VERDICT: a client that has not fetched the metadata yet reports no size, not 0 B', async () => {
    const driver = {
      supports: (c: DownloadClientRow) => c.enabled,
      testConnection: async () => ({ ok: true, messageKey: 'ok' }),
      getTorrents: async () => [],
      getTorrentsResult: async () => ({
        ok: true,
        torrents: [{
          hash: 'abcd', name: 'x', size: 0, downloaded: 0, progress: 0, dlspeed: 0, upspeed: 0,
          ratio: 0, eta: 60, state: 'metaDL', category: '', num_seeds: 0, num_leechs: 0, added_on: 0,
        }],
      }),
      getTorrentFilesResult: async () => ({ ok: true, files: [] }),
      addTorrentUrl: async () => 'x',
      deleteTorrent: async () => {},
      pauseTorrent: async () => {},
      resumeTorrent: async () => {},
    } as unknown as DownloadClientDriver;
    const deps = fakeDeps({
      downloadHistory: {
        findByStatuses: async () => [historyRow({ id: 1, torrentHash: 'abcd', downloadClientId: 1 })],
      },
      downloadClientsRepo: { listEnabled: async () => [clientRow({ id: 1 })] },
      downloadClientDrivers: { qbittorrent: driver },
    });
    const resolved = createRouteTable(deps).resolve('GET', '/queue')!;
    const res = await resolved.handler(req({ path: '/queue' }), resolved.params);
    assert.equal((res.body as { data: QueueItemDto[] }).data[0]!.size, null);
  });

  test('a history row stored with 0 reads the same way', async () => {
    const deps = fakeDeps({
      downloadHistory: { listPage: async () => ({ rows: [historyRow({ id: 1, size: 0 })], total: 1 }) },
    });
    const resolved = createRouteTable(deps).resolve('GET', '/history')!;
    const res = await resolved.handler(req({ path: '/history' }), resolved.params);
    assert.equal((res.body as { data: { size: number | null }[] }).data[0]!.size, null);
  });
});

describe('a manual grab keeps the tracker page', () => {
  function grabDeps() {
    const calls: unknown[] = [];
    return {
      calls,
      deps: fakeDeps({
        grabPipeline: {
          searchReleases: async () => [],
          grabRelease: async (_m: number, _s?: number, _e?: number, manual?: unknown) => {
            calls.push(manual);
            return { torrentHash: 'h' };
          },
        } as unknown as RouteDeps['grabPipeline'],
      }),
    };
  }

  const grab = async (deps: RouteDeps, body: unknown) => {
    const resolved = createRouteTable(deps).resolve('POST', '/5/grab')!;
    return resolved.handler(req({ method: 'POST', path: '/5/grab', body }), resolved.params);
  };

  test('forwards an http tracker page', async () => {
    const { deps, calls } = grabDeps();
    await grab(deps, { downloadUrl: 'https://x/dl', infoUrl: 'https://tracker.example/details/42' });
    assert.equal((calls[0] as { infoUrl?: string }).infoUrl, 'https://tracker.example/details/42');
  });

  test('VERDICT: drops anything that is not an http url — the sender is not who produced it', async () => {
    for (const bad of ['javascript:alert(1)', 'not a url', 'ftp://x/y', '']) {
      const { deps, calls } = grabDeps();
      await grab(deps, { downloadUrl: 'https://x/dl', infoUrl: bad });
      assert.equal((calls[0] as { infoUrl?: string }).infoUrl, undefined, `refused ${bad || '(empty)'}`);
    }
  });
});

/**
 * The media page reads the published set, not this route's answer. Without a push here the badge
 * kept saying "downloading 73%" on a torrent the operator had just paused, until the next poll a
 * minute out.
 */
describe('a queue control states the media set at once', () => {
  function controlDeps(row: DownloadHistoryRow) {
    const published: string[] = [];
    const deps = fakeDeps({
      downloadHistory: { findById: async () => row, markFailed: async () => {} },
      downloadClientsService: {
        pauseTorrent: async () => {},
        resumeTorrent: async () => {},
        removeTorrent: async () => {},
      } as unknown as RouteDeps['downloadClientsService'],
      settleAndPublish: async (r: DownloadHistoryRow, expect: string) => void published.push(`${r.mediaId}:${expect}`),
    });
    return { deps, published };
  }

  const run = async (deps: RouteDeps, method: string, path: string) => {
    const resolved = createRouteTable(deps).resolve(method, path)!;
    return resolved.handler(req({ method, path }), resolved.params);
  };

  const live = () =>
    historyRow({ id: 3, status: 'grabbed', torrentHash: 'abcd', downloadClientId: 1, mediaId: 12 });

  test('VERDICT: pause waits for the client to agree, then states the media set', async () => {
    const { deps, published } = controlDeps(live());
    await run(deps, 'POST', '/queue/3/pause');
    assert.deepEqual(published, ['12:paused']);
  });

  test('resume waits for the opposite', async () => {
    const { deps, published } = controlDeps(live());
    await run(deps, 'POST', '/queue/3/resume');
    assert.deepEqual(published, ['12:running']);
  });

  test('VERDICT: a removal waits for the torrent to be gone, so the set it states is without it', async () => {
    const { deps, published } = controlDeps(live());
    await run(deps, 'DELETE', '/queue/3');
    assert.deepEqual(published, ['12:absent']);
  });

  test('a publish failure never fails the control that succeeded', async () => {
    const { deps } = controlDeps(live());
    deps.settleAndPublish = async () => {
      throw new Error('boom');
    };
    assert.equal((await run(deps, 'POST', '/queue/3/pause')).status, 200);
  });
});

describe('history entries are records, not queue state', () => {
  const deleteRow = async (status: DownloadHistoryStatus) => {
    const removed: number[] = [];
    const deps = fakeDeps({
      downloadHistory: {
        findById: async () => historyRow({ id: 7, status }),
        remove: async (id: number) => void removed.push(id),
      },
    });
    const resolved = createRouteTable(deps).resolve('DELETE', '/history/7')!;
    const res = await resolved.handler(req({ method: 'DELETE', path: '/history/7' }), resolved.params);
    return { status: res.status, removed };
  };

  test('a finished grab can be deleted, whatever the outcome was', async () => {
    for (const s of ['completed', 'failed', 'warning'] as DownloadHistoryStatus[]) {
      assert.deepEqual(await deleteRow(s), { status: 200, removed: [7] }, s);
    }
  });

  test('VERDICT: a running grab is refused — deleting the row orphans the download, it does not stop it', async () => {
    for (const s of ['grabbed', 'importing'] as DownloadHistoryStatus[]) {
      const { status, removed } = await deleteRow(s);
      assert.equal(status, 409, s);
      assert.deepEqual(removed, [], s);
    }
  });
});

describe('the history status column reads like the queue while a row runs', () => {
  async function displayStatus(status: DownloadHistoryStatus, torrentState: string | null) {
    const driver = {
      supports: (c: DownloadClientRow) => c.enabled,
      testConnection: async () => ({ ok: true, messageKey: 'ok' }),
      getTorrents: async () => [],
      getTorrentsResult: async () => ({
        ok: true,
        torrents: torrentState
          ? [{ hash: 'abcd', name: 'x', size: 1, downloaded: 0, progress: 0.5, dlspeed: 0, upspeed: 0,
               ratio: 0, eta: 0, state: torrentState, category: '', num_seeds: 0, num_leechs: 0, added_on: 0 }]
          : [],
      }),
      getTorrentFilesResult: async () => ({ ok: true, files: [] }),
      addTorrentUrl: async () => 'x',
      deleteTorrent: async () => {},
      pauseTorrent: async () => {},
      resumeTorrent: async () => {},
    } as unknown as DownloadClientDriver;
    const deps = fakeDeps({
      downloadHistory: {
        listPage: async () => ({ rows: [historyRow({ id: 1, status, torrentHash: 'abcd', downloadClientId: 1 })], total: 1 }),
      },
      downloadClientsRepo: { listEnabled: async () => [clientRow({ id: 1 })] },
      downloadClientDrivers: { qbittorrent: driver },
    });
    const resolved = createRouteTable(deps).resolve('GET', '/history')!;
    const res = await resolved.handler(req({ path: '/history' }), resolved.params);
    return (res.body as { data: { status: string; displayStatus: string }[] }).data[0]!;
  }

  test('VERDICT: a paused grab reads "paused" here too, not "grabbed"', async () => {
    const row = await displayStatus('grabbed', 'pausedDL');
    assert.equal(row.displayStatus, 'paused');
    // The filter still queries the recorded status, so it is left alone.
    assert.equal(row.status, 'grabbed');
  });

  test('a terminal row reads what was recorded', async () => {
    assert.equal((await displayStatus('failed', null)).displayStatus, 'failed');
  });

  test('a running row whose client no longer holds it falls back to the record', async () => {
    assert.equal((await displayStatus('grabbed', null)).displayStatus, 'grabbed');
  });
});

describe('an error from the download client says what the client said', () => {
  const grabFailing = async (err: Error) => {
    const deps = fakeDeps({
      grabPipeline: {
        searchReleases: async () => [],
        grabRelease: async () => {
          throw err;
        },
      } as unknown as RouteDeps['grabPipeline'],
    });
    const resolved = createRouteTable(deps).resolve('POST', '/5/grab')!;
    const res = await resolved.handler(req({ method: 'POST', path: '/5/grab', body: {} }), resolved.params);
    return res as { status: number; body: { error: { key: string; detail: string } } };
  };

  test('VERDICT: a refusal from the client is a 502 naming it, not a generic internal error', async () => {
    const res = await grabFailing(new DownloadClientHttpError(409, 'the download client refused the torrent (HTTP 409)'));
    assert.equal(res.status, 502);
    assert.equal(res.body.error.key, 'download.http.errors.download_client');
    assert.equal(res.body.error.detail, 'the download client refused the torrent (HTTP 409)');
  });

  test('an unreachable client reads the same way', async () => {
    const res = await grabFailing(new DownloadClientUnreachableError('no host configured'));
    assert.equal(res.status, 502);
    assert.equal(res.body.error.detail, 'no host configured');
  });

  test('anything else stays internal, and still carries its message', async () => {
    const res = await grabFailing(new Error('boom'));
    assert.equal(res.status, 500);
    assert.equal(res.body.error.key, 'download.http.errors.internal');
    assert.equal(res.body.error.detail, 'boom');
  });
});

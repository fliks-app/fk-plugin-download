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
  LEGACY_PATHS,
  type RouteDeps,
  type PluginHttpRequest,
} from '../src/seams/http-routes';
import { IndexerNotFoundError } from '../src/indexers/types';
import { DownloadClientNotFoundError } from '../src/download-clients/types';

function fakeDeps(): RouteDeps {
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

  test('a declared-but-unbacked route (delay-profiles, queue) also resolves to null', () => {
    const table = createRouteTable(fakeDeps());
    assert.equal(table.resolve('GET', '/delay-profiles'), null);
    assert.equal(table.resolve('GET', '/queue'), null);
  });

  test('a legacy alias resolves to the same params and reaches the same handler as its target', async () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('GET', '/api/media/42/releases');
    assert.ok(resolved);
    assert.deepEqual(resolved!.params, { id: '42' });
    const res = await resolved!.handler(req({ path: '/api/media/42/releases' }), resolved!.params);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { releases: [{ probe: 'releases', mediaId: 42, seasonId: undefined, episodeId: undefined }] });
  });

  test('a season/episode id with no core objectGuard is still validated by the handler', async () => {
    const table = createRouteTable(fakeDeps());
    const resolved = table.resolve('GET', '/1/seasons/../releases')!;
    assert.ok(resolved);
    assert.equal(resolved.params['seasonId'], '..');
    const res = await resolved.handler(req({ path: '/1/seasons/../releases' }), resolved.params);
    assert.equal(res.status, 400);
  });

  test('every implemented manifest route and every legacy alias resolves; the two unbacked ones do not', () => {
    const table = createRouteTable(fakeDeps());
    const unimplemented = new Set(['GET /delay-profiles', 'GET /queue']);
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
    for (const oldKey of Object.keys(LEGACY_PATHS)) {
      const spaceAt = oldKey.indexOf(' ');
      const method = oldKey.slice(0, spaceAt);
      const path = oldKey.slice(spaceAt + 1).replace(/:[a-zA-Z]+/g, '1');
      assert.ok(table.resolve(method, path), `${oldKey} must resolve`);
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
  const DECLARED_BUT_UNBACKED = new Set(['GET /delay-profiles', 'GET /queue']);

  test('every canonical (non-legacy) handler key matches manifest ROUTES[], in both directions', () => {
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

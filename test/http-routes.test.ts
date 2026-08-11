/**
 * The route table's own matching, exercised directly (no socket, no DB) so every
 * adversarial case runs fast and asserts precisely. `test/harness.test.ts` covers the
 * same shape once over the real socket as proof core can actually reach it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteTable, ROUTES, LEGACY_PATHS, type RouteDeps, type PluginHttpRequest } from '../src/seams/http-routes';

function fakeDeps(): RouteDeps {
  return {
    indexerService: { findAll: async () => [] },
    downloadClientsService: { findAll: async () => [] },
    grabPipeline: {
      searchReleases: async (mediaId: number, seasonId?: number, episodeId?: number) => [{ probe: 'releases', mediaId, seasonId, episodeId }],
      grabRelease: async (mediaId: number) => ({ torrentHash: `hash-${mediaId}` }),
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

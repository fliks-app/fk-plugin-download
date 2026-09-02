import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEXER_SOURCE_DRIVERS } from '../src/indexer-sources/drivers';
import { IndexerSourceDisabledError, IndexerSourceService } from '../src/indexer-sources/service';
import { SourceUnreachableError } from '../src/indexer-sources/types';
import type { IndexerRow, IndexerSourceRow } from '../src/db/rows';
import type { CreateIndexerInput } from '../src/indexers/types';

function stubFetch(handler: (url: string) => { status: number; body: string }) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const { status, body } = handler(url);
    return new Response(body, { status }) as unknown as Response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const source = (over: Partial<IndexerSourceRow> = {}): IndexerSourceRow =>
  ({
    id: 1,
    name: 'prowlarr at home',
    implementation: 'prowlarr',
    settings: { baseUrl: 'http://prowlarr:9696', apiKey: 'KEY' },
    priority: 1,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as IndexerSourceRow;

const indexer = (over: Partial<IndexerRow> = {}): IndexerRow =>
  ({
    id: 10,
    name: 'tracker',
    implementation: 'torznab',
    settings: {},
    enableRss: true,
    enableSearch: true,
    priority: 25,
    requestDelay: 2,
    enabled: true,
    capsMovieSearch: false,
    capsTvSearch: false,
    capsSearchFallback: false,
    capsProbedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as IndexerRow;

/** The indexer side of the import, recording what it was asked to do. */
function fakeIndexers(existing: IndexerRow[] = []) {
  const rows = [...existing];
  const created: CreateIndexerInput[] = [];
  const settingsWrites: { id: number; settings: Record<string, unknown> }[] = [];
  return {
    created,
    settingsWrites,
    findByBaseUrl: async (baseUrl: string) =>
      rows.find((r) => String(r.settings['baseUrl'] ?? '') === baseUrl) ?? null,
    create: async (input: CreateIndexerInput) => {
      created.push(input);
      const row = indexer({ id: 100 + created.length, name: input.name, settings: input.settings ?? {} });
      rows.push(row);
      return row;
    },
    updateSettings: async (id: number, settings: Record<string, unknown>) => {
      settingsWrites.push({ id, settings });
      const row = rows.find((r) => r.id === id);
      if (row) row.settings = settings;
    },
  };
}

function serviceFor(row: IndexerSourceRow, indexers: ReturnType<typeof fakeIndexers>) {
  return new IndexerSourceService({
    repo: {
      listAll: async () => [row],
      findById: async (id: number) => (id === row.id ? row : null),
      insert: async () => row,
      update: async () => row,
      remove: async () => {},
    },
    drivers: INDEXER_SOURCE_DRIVERS,
    indexers,
  });
}

const PROWLARR_BODY = JSON.stringify([
  { id: 3, name: 'Tracker A', enable: true, protocol: 'torrent' },
  { id: 4, name: 'A Usenet Indexer', enable: true, protocol: 'usenet' },
]);

test('prowlarr: imports each torrent indexer as a torznab row, counting the usenet ones as unsupported', async () => {
  const fetchStub = stubFetch(() => ({ status: 200, body: PROWLARR_BODY }));
  try {
    const indexers = fakeIndexers();
    const summary = await serviceFor(source(), indexers).importFrom(1);

    assert.deepEqual(summary, { created: 1, updated: 0, unchanged: 0, unsupported: 1 });
    assert.equal(indexers.created.length, 1);
    assert.equal(indexers.created[0]!.name, 'Tracker A');
    assert.equal(indexers.created[0]!.implementation, 'torznab');
    // The endpoint prowlarr proxies that indexer on, with prowlarr's own key.
    assert.equal(indexers.created[0]!.settings!['baseUrl'], 'http://prowlarr:9696/3/api');
    assert.equal(indexers.created[0]!.settings!['apiKey'], 'KEY');
    assert.match(fetchStub.calls[0]!, /^http:\/\/prowlarr:9696\/api\/v1\/indexer\?apikey=KEY$/);
  } finally {
    fetchStub.restore();
  }
});

test('importing twice adds nothing the second time', async () => {
  const fetchStub = stubFetch(() => ({ status: 200, body: PROWLARR_BODY }));
  try {
    const indexers = fakeIndexers();
    const service = serviceFor(source(), indexers);

    await service.importFrom(1);
    const second = await service.importFrom(1);

    assert.deepEqual(second, { created: 0, updated: 0, unchanged: 1, unsupported: 1 });
    assert.equal(indexers.created.length, 1, 'the row created by the first run is matched, not duplicated');
    assert.equal(indexers.settingsWrites.length, 0, 'an unchanged key is not rewritten');
  } finally {
    fetchStub.restore();
  }
});

test('a re-import writes back a rotated API key, and leaves the name the admin chose', async () => {
  const fetchStub = stubFetch(() => ({ status: 200, body: PROWLARR_BODY }));
  try {
    const renamed = indexer({
      id: 42,
      name: 'my own name for it',
      settings: { baseUrl: 'http://prowlarr:9696/3/api', apiKey: 'OLD', minSeeders: 5 },
    });
    const indexers = fakeIndexers([renamed]);
    const summary = await serviceFor(source(), indexers).importFrom(1);

    assert.deepEqual(summary, { created: 0, updated: 1, unchanged: 0, unsupported: 1 });
    assert.deepEqual(indexers.settingsWrites, [
      { id: 42, settings: { baseUrl: 'http://prowlarr:9696/3/api', apiKey: 'KEY', minSeeders: 5 } },
    ]);
    assert.equal(renamed.name, 'my own name for it');
  } finally {
    fetchStub.restore();
  }
});

test('jackett: derives the torznab results endpoint and skips a tracker it reports as unconfigured', async () => {
  const body = JSON.stringify([
    { id: 'yts', name: 'YTS', configured: true },
    { id: 'nope', name: 'Not set up', configured: false },
  ]);
  const fetchStub = stubFetch(() => ({ status: 200, body }));
  try {
    const indexers = fakeIndexers();
    const row = source({ implementation: 'jackett', settings: { baseUrl: 'http://jackett:9117/', apiKey: 'JK' } });
    const summary = await serviceFor(row, indexers).importFrom(1);

    assert.deepEqual(summary, { created: 1, updated: 0, unchanged: 0, unsupported: 0 });
    assert.equal(
      indexers.created[0]!.settings!['baseUrl'],
      'http://jackett:9117/api/v2.0/indexers/yts/results/torznab/',
      'the trailing slash on the base URL must not double up',
    );
    assert.match(fetchStub.calls[0]!, /configured=true&apikey=JK$/);
  } finally {
    fetchStub.restore();
  }
});

test('an HTTP error from the source imports nothing and names the status', async () => {
  const fetchStub = stubFetch(() => ({ status: 401, body: 'unauthorized' }));
  try {
    const indexers = fakeIndexers();
    await assert.rejects(
      () => serviceFor(source(), indexers).importFrom(1),
      (e: unknown) => {
        assert.ok(e instanceof SourceUnreachableError);
        assert.equal(e.messageKey, 'download.indexer_sources.test.http_error');
        assert.equal(e.detail, '401');
        return true;
      },
    );
    assert.equal(indexers.created.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test('a login page instead of the indexer list is a refusal, never an empty import', async () => {
  const fetchStub = stubFetch(() => ({ status: 200, body: '<html><body>sign in</body></html>' }));
  try {
    const indexers = fakeIndexers();
    await assert.rejects(
      () => serviceFor(source(), indexers).importFrom(1),
      (e: unknown) => {
        assert.ok(e instanceof SourceUnreachableError);
        assert.equal(e.messageKey, 'download.indexer_sources.test.unexpected_response');
        return true;
      },
    );
    assert.equal(indexers.created.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test('a disabled source refuses to import, without reaching for the network', async () => {
  const fetchStub = stubFetch(() => ({ status: 200, body: PROWLARR_BODY }));
  try {
    const indexers = fakeIndexers();
    await assert.rejects(
      () => serviceFor(source({ enabled: false }), indexers).importFrom(1),
      (e: unknown) => e instanceof IndexerSourceDisabledError,
    );
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test('testConnection reports the reason rather than throwing it', async () => {
  const fetchStub = stubFetch(() => ({ status: 200, body: JSON.stringify([]) }));
  try {
    const service = serviceFor(source(), fakeIndexers());
    assert.deepEqual(await service.testConnection({ implementation: 'prowlarr', settings: { baseUrl: 'http://prowlarr:9696', apiKey: 'KEY' } }), {
      ok: true,
      messageKey: 'download.indexer_sources.test.ok',
    });
    assert.deepEqual(await service.testConnection({ implementation: 'nzbhydra', settings: {} }), {
      ok: false,
      messageKey: 'download.indexer_sources.test.unknown_implementation',
      detail: 'nzbhydra',
    });
    const noUrl = await service.testConnection({ implementation: 'prowlarr', settings: { apiKey: 'KEY' } });
    assert.equal(noUrl.ok, false);
    assert.equal(noUrl.messageKey, 'download.indexer_sources.test.base_url_missing');
  } finally {
    fetchStub.restore();
  }
});

test('a saved source tests with the key it stored, so a blank field is not a wrong key', async () => {
  const fetchStub = stubFetch(() => ({ status: 200, body: JSON.stringify([]) }));
  try {
    const service = serviceFor(source(), fakeIndexers());
    const result = await service.testConnection({
      implementation: 'prowlarr',
      id: 1,
      settings: { baseUrl: 'http://prowlarr:9696', apiKey: '' },
    });
    assert.equal(result.ok, true);
    assert.match(fetchStub.calls[0]!, /apikey=KEY$/);
  } finally {
    fetchStub.restore();
  }
});

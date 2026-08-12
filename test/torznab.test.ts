import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TorznabClient } from '../src/indexers/torznab';
import { IndexerThrottle } from '../src/indexers/throttle';
import type { IndexerRow, IndexerStatRow } from '../src/db/rows';
import type { IndexerRepository, IndexerStatsRecorder } from '../src/indexers/types';

const indexer = (over: Partial<IndexerRow> = {}): IndexerRow =>
  ({
    id: 1,
    name: 'test',
    implementation: 'torznab',
    settings: {},
    enableRss: true,
    enableSearch: true,
    priority: 25,
    requestDelay: 0,
    enabled: true,
    capsMovieSearch: false,
    capsTvSearch: false,
    capsSearchFallback: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as IndexerRow;

const emptyTorznabBody = '<?xml version="1.0"?><rss><channel></channel></rss>';

function stubFetch(handler: (url: string) => { status: number; body: string; headers?: Record<string, string> }) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const { status, body, headers } = handler(url);
    return new Response(body, { status, headers }) as unknown as Response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function makeClient() {
  const statRows: Omit<IndexerStatRow, 'id' | 'queryDate'>[] = [];
  const updates: { id: number; patch: Partial<IndexerRow> }[] = [];
  const stats: IndexerStatsRecorder = { record: async (s) => void statRows.push(s) };
  const repo: Pick<IndexerRepository, 'update'> = {
    update: async (id, patch) => {
      updates.push({ id, patch });
      return { ...indexer(), ...patch, id } as IndexerRow;
    },
  };
  const throttle = new IndexerThrottle();
  const client = new TorznabClient({ stats, repo, throttle });
  return { client, statRows, updates, throttle };
}

test('searchMovie resolves baseUrl/apiKey from settings and builds a plain t=search URL when caps are unknown', async () => {
  const { client } = makeClient();
  const stub = stubFetch(() => ({ status: 200, body: emptyTorznabBody }));
  try {
    const results = await client.searchMovie(
      indexer({ settings: { baseUrl: 'https://tracker.tld/api', apiKey: 'probe-key' } }),
      'Some Movie',
    );
    assert.deepEqual(results, []);
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0]?.startsWith('https://tracker.tld/api?'));
    assert.ok(stub.calls[0]?.includes('apikey=probe-key'));
    assert.ok(stub.calls[0]?.includes('t=search'));
  } finally {
    stub.restore();
  }
});

test('searchMovie skips when enableSearch is false, even though the indexer is enabled', async () => {
  const { client } = makeClient();
  const stub = stubFetch(() => ({ status: 200, body: emptyTorznabBody }));
  try {
    const results = await client.searchMovie(
      indexer({ enableSearch: false, settings: { baseUrl: 'https://tracker.tld/api', apiKey: 'k' } }),
      'Some Movie',
    );
    assert.deepEqual(results, []);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('rssSearch skips when enableRss is false, even though enabled and enableSearch are true', async () => {
  const { client } = makeClient();
  const stub = stubFetch(() => ({ status: 200, body: emptyTorznabBody }));
  try {
    const results = await client.rssSearch(
      indexer({ enableRss: false, settings: { baseUrl: 'https://tracker.tld/api', apiKey: 'k' } }),
    );
    assert.deepEqual(results, []);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('refreshCaps has no enabled/enableSearch gate — still refreshes a disabled indexer', async () => {
  const { client, updates } = makeClient();
  const stub = stubFetch(() => ({
    status: 200,
    body: '<caps><searching><movie-search available="yes"/><tv-search available="no"/></searching></caps>',
  }));
  try {
    const ix = indexer({ enabled: false, enableSearch: false, settings: { baseUrl: 'https://tracker.tld/api', apiKey: 'k' } });
    await client.refreshCaps(ix);
    assert.equal(stub.calls.length, 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.patch.capsMovieSearch, true);
    assert.equal(updates[0]?.patch.capsTvSearch, false);
    assert.equal(ix.capsMovieSearch, true, 'mutates the passed row in place so later calls in the same batch see it');
  } finally {
    stub.restore();
  }
});

test('filterReadyIndexers drops only the indexer currently in cooldown', () => {
  const { client, throttle } = makeClient();
  const a = indexer({ id: 1, name: 'a' });
  const b = indexer({ id: 2, name: 'b' });
  throttle.notifyFailure(b);
  const ready = client.filterReadyIndexers([a, b]);
  assert.deepEqual(ready.map((i) => i.id), [1]);
});

test('a 429 with Retry-After during execSearch feeds the throttle, and the retry is honoured on the next call', async () => {
  const { client, throttle } = makeClient();
  let call = 0;
  const stub = stubFetch(() => {
    call++;
    return call === 1
      ? { status: 429, body: '', headers: { 'retry-after': '60' } }
      : { status: 200, body: emptyTorznabBody };
  });
  try {
    const ix = indexer({ settings: { baseUrl: 'https://tracker.tld/api', apiKey: 'k' } });
    const results = await client.searchMovie(ix, 'Some Movie');
    assert.deepEqual(results, []);
    const remaining = throttle.cooldownRemainingMs(ix.id);
    assert.ok(remaining > 55_000 && remaining <= 60_000, `expected ~60s cooldown from Retry-After, got ${remaining}ms`);
  } finally {
    stub.restore();
  }
});

test('testConnection: empty baseUrl reports base_url_missing without hitting the network', async () => {
  const { client } = makeClient();
  const stub = stubFetch(() => ({ status: 200, body: '<caps></caps>' }));
  try {
    const result = await client.testConnection('', 'k');
    assert.deepEqual(result, { ok: false, messageKey: 'download.indexers.test.base_url_missing' });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('testConnection: a caps document reports ok', async () => {
  const { client } = makeClient();
  const stub = stubFetch(() => ({ status: 200, body: '<caps><searching/></caps>' }));
  try {
    const result = await client.testConnection('https://tracker.example', 'k');
    assert.deepEqual(result, { ok: true, messageKey: 'download.indexers.test.ok' });
  } finally {
    stub.restore();
  }
});

test('testConnection: a 200 response with no <caps> document reports unexpected_response', async () => {
  const { client } = makeClient();
  const stub = stubFetch(() => ({ status: 200, body: '<html>not torznab</html>' }));
  try {
    const result = await client.testConnection('https://tracker.example', 'k');
    assert.deepEqual(result, { ok: false, messageKey: 'download.indexers.test.unexpected_response' });
  } finally {
    stub.restore();
  }
});

test('testConnection: a Torznab <error> document reports torznab_error with its description as detail', async () => {
  const { client } = makeClient();
  const stub = stubFetch(() => ({ status: 200, body: '<error code="100" description="Invalid API Key"/>' }));
  try {
    const result = await client.testConnection('https://tracker.example', 'bad-key');
    assert.deepEqual(result, { ok: false, messageKey: 'download.indexers.test.torznab_error', detail: 'Invalid API Key' });
  } finally {
    stub.restore();
  }
});

test('testConnection: an HTTP error status reports http_error with the status code as detail', async () => {
  const { client } = makeClient();
  const stub = stubFetch(() => ({ status: 503, body: '' }));
  try {
    const result = await client.testConnection('https://tracker.example', 'k');
    assert.deepEqual(result, { ok: false, messageKey: 'download.indexers.test.http_error', detail: '503' });
  } finally {
    stub.restore();
  }
});

test('testConnection: a network failure reports network_error with the underlying message as detail', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  try {
    const { client } = makeClient();
    const result = await client.testConnection('https://tracker.example', 'k');
    assert.deepEqual(result, { ok: false, messageKey: 'download.indexers.test.network_error', detail: 'ECONNREFUSED' });
  } finally {
    globalThis.fetch = original;
  }
});

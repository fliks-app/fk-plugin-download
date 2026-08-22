import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexerService } from '../src/indexers/service';
import { IndexerNotFoundError, UnknownIndexerImplementationError } from '../src/indexers/types';
import type { IndexerRow } from '../src/db/rows';
import type { IndexerRepository } from '../src/indexers/types';

function makeService() {
  const rows = new Map<number, IndexerRow>();
  let nextId = 1;
  const repo: IndexerRepository = {
    findAll: async () => [...rows.values()],
    findOne: async (id) => rows.get(id) ?? null,
    insert: async (row) => {
      const saved = { ...row, id: nextId++, createdAt: 'now', updatedAt: 'now' } as IndexerRow;
      rows.set(saved.id, saved);
      return saved;
    },
    update: async (id, patch) => {
      const existing = rows.get(id);
      if (!existing) throw new Error('not found');
      const saved = { ...existing, ...patch };
      rows.set(id, saved);
      return saved;
    },
    markSearchFallback: async (id) => {
      const existing = rows.get(id);
      if (existing) rows.set(id, { ...existing, capsSearchFallback: true });
    },
    refreshCaps: async (id, caps) => {
      const existing = rows.get(id);
      if (existing) rows.set(id, { ...existing, ...caps, capsProbedAt: 'now' });
    },
    remove: async (id) => void rows.delete(id),
  };
  const refreshCapsCalls: IndexerRow[] = [];
  const torznab = {
    refreshCaps: async (ix: IndexerRow) => void refreshCapsCalls.push(ix),
    testConnection: async () => ({ ok: true, messageKey: 'download.indexers.test.ok' as const }),
  };
  const throttle = { getCooldown: () => null, clearCooldown: () => false, clearAllCooldowns: () => 0 };
  const service = new IndexerService({ repo, torznab, throttle });
  return { service, repo, torznab, refreshCapsCalls };
}

test('creates with the "torznab" implementation and triggers a caps refresh', async () => {
  const { service, refreshCapsCalls } = makeService();
  const result = await service.create({ name: 'X', implementation: 'torznab', settings: { baseUrl: 'https://x.tld', apiKey: 'k' } });
  assert.equal(result.implementation, 'torznab');
  assert.equal(result.settings.apiKey, undefined, 'create() redacts the apiKey from its own return value');
  await Promise.resolve(); // let the fire-and-forget refreshCaps() microtask settle
  assert.equal(refreshCapsCalls.length, 1);
});

test('a caps probe that rejects never becomes an unhandled rejection', async () => {
  const { service, torznab } = makeService();
  torznab.refreshCaps = () => Promise.reject(new IndexerNotFoundError('Indexer #1 not found'));
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    await service.create({ name: 'X', implementation: 'torznab', settings: { baseUrl: 'https://x.tld', apiKey: 'k' } });
    await service.update(1, { name: 'Y' });
    // Two macrotask turns: an unhandled rejection is only reported once the microtask queue drains.
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, [], 'a rejected fire-and-forget probe would take the whole plugin process down');
});

test('refuses an unregistered implementation on create, naming it', async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.create({ name: 'X', implementation: 'fliks.missing-plugin.tracker', settings: {} }),
    (err: unknown) => err instanceof UnknownIndexerImplementationError && /fliks\.missing-plugin\.tracker/.test((err as Error).message),
  );
});

test('refuses an unregistered implementation on update, naming it', async () => {
  const { service, repo } = makeService();
  const created = await repo.insert({
    name: 'X',
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
  });
  await assert.rejects(
    () => service.update(created.id, { implementation: 'fliks.missing-plugin.tracker' }),
    UnknownIndexerImplementationError,
  );
});

test('update() keeps the stored apiKey when the incoming settings omit it', async () => {
  const { service, repo } = makeService();
  const created = await repo.insert({
    name: 'X',
    implementation: 'torznab',
    settings: { baseUrl: 'https://x.tld', apiKey: 'original-key' },
    enableRss: true,
    enableSearch: true,
    priority: 25,
    requestDelay: 2,
    enabled: true,
    capsMovieSearch: false,
    capsTvSearch: false,
    capsSearchFallback: false,
    capsProbedAt: null,
  });
  await service.update(created.id, { settings: { baseUrl: 'https://y.tld' } });
  const stored = await repo.findOne(created.id);
  assert.equal(stored?.settings.apiKey, 'original-key');
  assert.equal(stored?.settings.baseUrl, 'https://y.tld');
});

test('a redacted row reports whether an apiKey is stored, so the editor can mask it', async () => {
  const { service, repo } = makeService();
  await repo.insert({
    name: 'X',
    implementation: 'torznab',
    settings: { baseUrl: 'https://x.tld', apiKey: 'original-key' },
    enableRss: true,
    enableSearch: true,
    priority: 25,
    requestDelay: 2,
    enabled: true,
    capsMovieSearch: false,
    capsTvSearch: false,
    capsSearchFallback: false,
    capsProbedAt: null,
  });
  const [withKey] = await service.findAll();
  assert.deepEqual(withKey?.settings.secretsSet, ['apiKey']);

  await service.update(withKey!.id, { settings: { baseUrl: 'https://x.tld', apiKey: null } });
  const [cleared] = await service.findAll();
  assert.deepEqual(cleared?.settings.secretsSet, []);
});

test('update() erases the stored apiKey when the incoming settings send an explicit null', async () => {
  const { service, repo } = makeService();
  const created = await repo.insert({
    name: 'X',
    implementation: 'torznab',
    settings: { baseUrl: 'https://x.tld', apiKey: 'original-key' },
    enableRss: true,
    enableSearch: true,
    priority: 25,
    requestDelay: 2,
    enabled: true,
    capsMovieSearch: false,
    capsTvSearch: false,
    capsSearchFallback: false,
    capsProbedAt: null,
  });
  await service.update(created.id, { settings: { baseUrl: 'https://x.tld', apiKey: null } });
  const stored = await repo.findOne(created.id);
  assert.deepEqual(stored?.settings, { baseUrl: 'https://x.tld' });
});

test('update() never persists the read-only marker a client echoes back', async () => {
  const { service, repo } = makeService();
  const created = await repo.insert({
    name: 'X',
    implementation: 'torznab',
    settings: { baseUrl: 'https://x.tld', apiKey: 'original-key' },
    enableRss: true,
    enableSearch: true,
    priority: 25,
    requestDelay: 2,
    enabled: true,
    capsMovieSearch: false,
    capsTvSearch: false,
    capsSearchFallback: false,
    capsProbedAt: null,
  });
  await service.update(created.id, { settings: { baseUrl: 'https://x.tld', secretsSet: ['apiKey'] } });
  const stored = await repo.findOne(created.id);
  assert.deepEqual(stored?.settings, { baseUrl: 'https://x.tld', apiKey: 'original-key' });
});

test('findOne throws IndexerNotFoundError, naming the id, for a missing row', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.findOne(999), (err: unknown) => err instanceof IndexerNotFoundError && /#999/.test((err as Error).message));
});

test('VERDICT: testConnection on a saved row uses the stored apiKey when none is submitted', async () => {
  const { service, repo, torznab } = makeService();
  const seen: { baseUrl: string; apiKey: string }[] = [];
  torznab.testConnection = (async (baseUrl: string, apiKey: string) => {
    seen.push({ baseUrl, apiKey });
    return { ok: true, messageKey: 'download.indexers.test.ok' as const };
  }) as typeof torznab.testConnection;
  const created = await repo.insert({
    name: 'X',
    implementation: 'torznab',
    settings: { baseUrl: 'https://x.tld', apiKey: 'stored-key' },
    enableRss: true,
    enableSearch: true,
    priority: 25,
    requestDelay: 2,
    enabled: true,
    capsMovieSearch: false,
    capsTvSearch: false,
    capsSearchFallback: false,
    capsProbedAt: null,
  });

  // The client never receives the key on read, so testing an edit submits none.
  await service.testConnection({ implementation: 'torznab', settings: { baseUrl: 'https://x.tld' }, id: created.id });
  assert.equal(seen[0]?.apiKey, 'stored-key');

  // A submitted key still wins — that is how a rotated key gets tested before it is saved.
  await service.testConnection({
    implementation: 'torznab',
    settings: { baseUrl: 'https://x.tld', apiKey: 'typed-key' },
    id: created.id,
  });
  assert.equal(seen[1]?.apiKey, 'typed-key');

  // A pending erase tests without a key: that is the row about to be saved.
  await service.testConnection({
    implementation: 'torznab',
    settings: { baseUrl: 'https://x.tld', apiKey: null },
    id: created.id,
  });
  assert.equal(seen[2]?.apiKey, '');

  // A new draft has no row to fall back on, and an unknown id must not throw.
  await service.testConnection({ implementation: 'torznab', settings: { baseUrl: 'https://x.tld' } });
  assert.equal(seen[3]?.apiKey, '');
  await service.testConnection({ implementation: 'torznab', settings: { baseUrl: 'https://x.tld' }, id: 4242 });
  assert.equal(seen[4]?.apiKey, '');
});

test('testConnection reports unknown_implementation, naming it, without calling the torznab client', async () => {
  const { service, torznab } = makeService();
  let called = false;
  torznab.testConnection = async () => {
    called = true;
    return { ok: true, messageKey: 'download.indexers.test.ok' as const };
  };
  const result = await service.testConnection({ implementation: 'fliks.missing-plugin.tracker', settings: {} });
  assert.equal(result.ok, false);
  assert.equal(result.messageKey, 'download.indexers.test.unknown_implementation');
  assert.equal(result.detail, 'fliks.missing-plugin.tracker');
  assert.equal(called, false);
});

test('sanitizeSettings floors and clamps minSeeders to a non-negative integer', async () => {
  const { service, repo } = makeService();
  const created = await service.create({ name: 'X', implementation: 'torznab', settings: { minSeeders: -3.7 } });
  const stored = await repo.findOne(created.id);
  assert.equal(stored?.settings.minSeeders, 0);

  const created2 = await service.create({ name: 'Y', implementation: 'torznab', settings: { minSeeders: 4.9 } });
  const stored2 = await repo.findOne(created2.id);
  assert.equal(stored2?.settings.minSeeders, 4);
});

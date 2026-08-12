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
  });
  await service.update(created.id, { settings: { baseUrl: 'https://y.tld' } });
  const stored = await repo.findOne(created.id);
  assert.equal(stored?.settings.apiKey, 'original-key');
  assert.equal(stored?.settings.baseUrl, 'https://y.tld');
});

test('findOne throws IndexerNotFoundError, naming the id, for a missing row', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.findOne(999), (err: unknown) => err instanceof IndexerNotFoundError && /#999/.test((err as Error).message));
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

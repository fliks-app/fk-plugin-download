import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DownloadClientsService } from '../src/download-clients/service';
import { DownloadClientNotFoundError, UnsupportedDownloadClientError, BLOCK_REASON_KEY, type StalledAnnotatable } from '../src/download-clients/types';
import type { DownloadClientDriver, ClientTorrent } from '../src/download-clients/contract';
import type { DownloadClientRow, DownloadHistoryRow, BlocklistRow } from '../src/db/rows';

function row(over: Partial<DownloadClientRow> = {}): DownloadClientRow {
  return {
    id: 1,
    name: 'X',
    implementation: 'qbittorrent',
    settings: { host: 'h', password: 'secret' },
    enabled: true,
    priority: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function fakeDriver(over: Partial<DownloadClientDriver> = {}): DownloadClientDriver {
  return {
    supports: (c) => c.enabled && c.implementation === 'qbittorrent',
    testConnection: async () => ({ ok: true, messageKey: 'download.download_clients.test.ok' }),
    getTorrents: async () => [],
    getTorrentsResult: async () => ({ ok: true, torrents: [] }),
    getTorrentFilesResult: async () => ({ ok: true, files: [] }),
    addTorrentUrl: async () => 'a'.repeat(40),
    deleteTorrent: async () => {},
    ...over,
  };
}

function makeService(overDeps: Record<string, unknown> = {}) {
  const rows = new Map<number, DownloadClientRow>();
  let nextId = 1;
  const repo = {
    listAll: async () => [...rows.values()],
    listEnabled: async () => [...rows.values()].filter((r) => r.enabled),
    findById: async (id: number) => rows.get(id) ?? null,
    insert: async (input: Omit<DownloadClientRow, 'id' | 'createdAt' | 'updatedAt'>) => {
      const saved: DownloadClientRow = { ...input, id: nextId++, createdAt: 'now', updatedAt: 'now' };
      rows.set(saved.id, saved);
      return saved;
    },
    update: async (id: number, input: Omit<DownloadClientRow, 'id' | 'createdAt' | 'updatedAt'>) => {
      const existing = rows.get(id);
      if (!existing) throw new Error('not found');
      const saved = { ...existing, ...input };
      rows.set(id, saved);
      return saved;
    },
    remove: async (id: number) => void rows.delete(id),
  };

  const historyRows: DownloadHistoryRow[] = [];
  const failedCalls: { id: number; statusMessage: string }[] = [];
  const history = {
    findLatestByTorrentHash: async (hash: string) =>
      historyRows.find((h) => h.torrentHash?.toLowerCase() === hash.toLowerCase()) ?? null,
    findLatestBySourceTitle: async (title: string) => historyRows.find((h) => h.sourceTitle === title) ?? null,
    markFailed: async (id: number, statusMessage: string) => void failedCalls.push({ id, statusMessage }),
  };

  const blocklistInserts: unknown[] = [];
  let blocklistShouldThrow = false;
  const blocklist = {
    insert: async (input: Omit<BlocklistRow, 'id' | 'createdAt' | 'updatedAt'>) => {
      if (blocklistShouldThrow) throw new Error('duplicate key value violates unique constraint');
      blocklistInserts.push(input);
      return { ...input, id: 1, createdAt: 'now', updatedAt: 'now' } as BlocklistRow;
    },
  };

  const stalledSnapshots = { findRecentForHashes: async () => [] as { torrentHash: string; downloadedBytes: number; checkedAt: string }[] };

  const drivers: Record<string, DownloadClientDriver> = { qbittorrent: fakeDriver() };
  const onMediaBlocklistedCalls: number[] = [];

  const deps = {
    repo,
    drivers,
    history,
    blocklist,
    stalledSnapshots,
    onMediaBlocklisted: (mediaId: number) => void onMediaBlocklistedCalls.push(mediaId),
    ...overDeps,
  };

  const service = new DownloadClientsService(deps as never);
  return { service, repo, historyRows, failedCalls, blocklistInserts, setBlocklistThrows: (v: boolean) => (blocklistShouldThrow = v), drivers, onMediaBlocklistedCalls };
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

test('create() redacts the password from its own return value', async () => {
  const { service } = makeService();
  const result = await service.create({ name: 'X', implementation: 'qbittorrent', settings: { host: 'h', password: 'secret' } });
  assert.deepEqual(result.settings, { host: 'h', secretsSet: ['password'] });
});

test('findAll() redacts the password from every row', async () => {
  const { service, repo } = makeService();
  await repo.insert({ name: 'A', implementation: 'qbittorrent', settings: { host: 'a', password: 'p1' }, enabled: true, priority: 1 });
  await repo.insert({ name: 'B', implementation: 'qbittorrent', settings: { host: 'b', password: 'p2' }, enabled: true, priority: 2 });
  const rows = await service.findAll();
  assert.deepEqual(rows.map((r) => r.settings), [
    { host: 'a', secretsSet: ['password'] },
    { host: 'b', secretsSet: ['password'] },
  ]);
});

test('findOne() does NOT redact — the HTTP boundary is responsible for that, same as IndexerService', async () => {
  const { service, repo } = makeService();
  const saved = await repo.insert({ name: 'X', implementation: 'qbittorrent', settings: { password: 'secret' }, enabled: true, priority: 1 });
  const result = await service.findOne(saved.id);
  assert.deepEqual(result.settings, { password: 'secret' });
});

test('update() keeps the stored password when the incoming settings omit it', async () => {
  const { service, repo } = makeService();
  const saved = await repo.insert({ name: 'X', implementation: 'qbittorrent', settings: { host: 'h', password: 'stored' }, enabled: true, priority: 1 });
  const result = await service.update(saved.id, { settings: { host: 'h2' } });
  assert.deepEqual(result.settings, { host: 'h2', secretsSet: ['password'] });
  const stored = await repo.findById(saved.id);
  assert.deepEqual(stored?.settings, { host: 'h2', password: 'stored' });
});

test('a redacted row reports no set secret once there is nothing stored', async () => {
  const { service, repo } = makeService();
  await repo.insert({ name: 'A', implementation: 'qbittorrent', settings: { host: 'a' }, enabled: true, priority: 1 });
  const rows = await service.findAll();
  assert.deepEqual(rows[0]?.settings, { host: 'a', secretsSet: [] });
});

test('update() erases the stored password when the incoming settings send an explicit null', async () => {
  const { service, repo } = makeService();
  const saved = await repo.insert({ name: 'X', implementation: 'qbittorrent', settings: { host: 'h', password: 'stored' }, enabled: true, priority: 1 });
  const result = await service.update(saved.id, { settings: { host: 'h', password: null } });
  const stored = await repo.findById(saved.id);
  assert.deepEqual(stored?.settings, { host: 'h' });
  assert.deepEqual(result.settings, { host: 'h', secretsSet: [] });
});

test('update() never persists the read-only marker a client echoes back', async () => {
  const { service, repo } = makeService();
  const saved = await repo.insert({ name: 'X', implementation: 'qbittorrent', settings: { host: 'h', password: 'stored' }, enabled: true, priority: 1 });
  await service.update(saved.id, { settings: { host: 'h', secretsSet: ['password'] } });
  const stored = await repo.findById(saved.id);
  assert.deepEqual(stored?.settings, { host: 'h', password: 'stored' });
});

test('update() overwrites the stored password when the incoming settings send a non-empty one', async () => {
  const { service, repo } = makeService();
  const saved = await repo.insert({ name: 'X', implementation: 'qbittorrent', settings: { host: 'h', password: 'stored' }, enabled: true, priority: 1 });
  await service.update(saved.id, { settings: { host: 'h', password: 'new' } });
  const stored = await repo.findById(saved.id);
  assert.equal(stored?.settings.password, 'new');
});

// ---------------------------------------------------------------------------
// CRUD / implementation validation
// ---------------------------------------------------------------------------

test('create() refuses an unregistered implementation, naming it', async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.create({ name: 'X', implementation: 'transmission', settings: {} }),
    (err: unknown) => err instanceof UnsupportedDownloadClientError && /transmission/.test((err as Error).message),
  );
});

test('findOne() throws DownloadClientNotFoundError, naming the id, for a missing row', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.findOne(999), (err: unknown) => err instanceof DownloadClientNotFoundError && /#999/.test((err as Error).message));
});

test('remove() 404s via findOne before deleting', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.remove(999), DownloadClientNotFoundError);
});

test('create() defaults enabled=true and priority=1', async () => {
  const { service } = makeService();
  const result = await service.create({ name: 'X', implementation: 'qbittorrent' });
  assert.equal(result.enabled, true);
  assert.equal(result.priority, 1);
});

// ---------------------------------------------------------------------------
// testConnection / removeTorrent
// ---------------------------------------------------------------------------

test('testConnection reports unsupported_implementation, naming it, without calling any driver', async () => {
  const { service, drivers } = makeService();
  let called = false;
  drivers.qbittorrent = fakeDriver({ testConnection: async () => { called = true; return { ok: true, messageKey: 'download.download_clients.test.ok' }; } });
  const result = await service.testConnection({ implementation: 'transmission', settings: {} });
  assert.equal(result.ok, false);
  assert.equal(result.messageKey, 'download.download_clients.test.unsupported_implementation');
  assert.equal(result.detail, 'transmission');
  assert.equal(called, false);
});

test('removeTorrent calls deleteTorrent on the resolved driver', async () => {
  const deleted: { hash: string; deleteFiles?: boolean }[] = [];
  const { service, repo } = makeService({ drivers: { qbittorrent: fakeDriver({ deleteTorrent: async (_c, hash, deleteFiles) => void deleted.push({ hash, deleteFiles }) }) } });
  const saved = await repo.insert({ name: 'X', implementation: 'qbittorrent', settings: {}, enabled: true, priority: 1 });
  await service.removeTorrent(saved.id, 'abc', true);
  assert.deepEqual(deleted, [{ hash: 'abc', deleteFiles: true }]);
});

test('removeTorrent throws UnsupportedDownloadClientError for a disabled client', async () => {
  const { service, repo } = makeService();
  const saved = await repo.insert({ name: 'X', implementation: 'qbittorrent', settings: {}, enabled: false, priority: 1 });
  await assert.rejects(() => service.removeTorrent(saved.id, 'abc', false), UnsupportedDownloadClientError);
});

// ---------------------------------------------------------------------------
// blockTorrent
// ---------------------------------------------------------------------------

test('blockTorrent: history found by hash directly -> blocklists, deletes with files, marks history failed, notifies', async () => {
  const { service, repo, historyRows, failedCalls, blocklistInserts, onMediaBlocklistedCalls } = makeService();
  const saved = await repo.insert({ name: 'X', implementation: 'qbittorrent', settings: {}, enabled: true, priority: 1 });
  historyRows.push({
    id: 42,
    sourceTitle: 'Some.Release.1080p',
    quality: '1080p',
    language: null,
    torrentHash: 'abc',
    size: null,
    status: 'grabbed',
    statusMessage: null,
    grabSource: 'auto',
    mediaId: 7,
    episodeId: null,
    seasonId: null,
    indexerId: 3,
    downloadClientId: saved.id,
    createdAt: 'now',
    updatedAt: 'now',
  });

  await service.blockTorrent(saved.id, 'abc');

  assert.equal(blocklistInserts.length, 1);
  assert.deepEqual(blocklistInserts[0], { sourceTitle: 'Some.Release.1080p', quality: '1080p', mediaId: 7, indexerId: 3, note: BLOCK_REASON_KEY });
  assert.deepEqual(failedCalls, [{ id: 42, statusMessage: BLOCK_REASON_KEY }]);
  assert.deepEqual(onMediaBlocklistedCalls, [7]);
});

test('blockTorrent: falls back to scanning enabled clients\' live torrents by hash, then history by exact name', async () => {
  const torrents: ClientTorrent[] = [
    {
      hash: 'deadbeef',
      name: 'Fallback.Release.720p',
      size: 1,
      downloaded: 0,
      progress: 0.5,
      dlspeed: 0,
      upspeed: 0,
      ratio: 0,
      eta: 0,
      state: 'downloading',
      category: '',
      num_seeds: 1,
      num_leechs: 1,
      added_on: 0,
    },
  ];
  const { service, repo, historyRows, failedCalls } = makeService({
    drivers: { qbittorrent: fakeDriver({ getTorrents: async () => torrents }) },
  });
  const saved = await repo.insert({ name: 'X', implementation: 'qbittorrent', settings: {}, enabled: true, priority: 1 });
  historyRows.push({
    id: 99,
    sourceTitle: 'Fallback.Release.720p',
    quality: '720p',
    language: null,
    torrentHash: null, // not stored yet — this is exactly the fallback path
    size: null,
    status: 'grabbed',
    statusMessage: null,
    grabSource: 'auto',
    mediaId: null,
    episodeId: null,
    seasonId: null,
    indexerId: null,
    downloadClientId: saved.id,
    createdAt: 'now',
    updatedAt: 'now',
  });

  await service.blockTorrent(saved.id, 'deadbeef');
  assert.deepEqual(failedCalls, [{ id: 99, statusMessage: BLOCK_REASON_KEY }]);
});

test('blockTorrent: no matching history -> still deletes the torrent, no markFailed, no notify', async () => {
  const deleted: string[] = [];
  const { service, repo, failedCalls, onMediaBlocklistedCalls } = makeService({
    drivers: { qbittorrent: fakeDriver({ deleteTorrent: async (_c, hash) => void deleted.push(hash) }) },
  });
  const saved = await repo.insert({ name: 'X', implementation: 'qbittorrent', settings: {}, enabled: true, priority: 1 });
  await service.blockTorrent(saved.id, 'unmatched-hash');
  assert.deepEqual(deleted, ['unmatched-hash']);
  assert.deepEqual(failedCalls, []);
  assert.deepEqual(onMediaBlocklistedCalls, []);
});

test('blockTorrent: an already-blocklisted release (insert throws) still gets deleted and marked failed', async () => {
  const { service, repo, historyRows, failedCalls, setBlocklistThrows } = makeService();
  const saved = await repo.insert({ name: 'X', implementation: 'qbittorrent', settings: {}, enabled: true, priority: 1 });
  historyRows.push({
    id: 5,
    sourceTitle: 'Already.Blocked',
    quality: '',
    language: null,
    torrentHash: 'abc',
    size: null,
    status: 'grabbed',
    statusMessage: null,
    grabSource: 'auto',
    mediaId: null,
    episodeId: null,
    seasonId: null,
    indexerId: null,
    downloadClientId: saved.id,
    createdAt: 'now',
    updatedAt: 'now',
  });
  setBlocklistThrows(true);
  await service.blockTorrent(saved.id, 'abc');
  assert.deepEqual(failedCalls, [{ id: 5, statusMessage: BLOCK_REASON_KEY }]);
});

test('blockTorrent: throws UnsupportedDownloadClientError for an unknown client id, before touching anything', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.blockTorrent(999, 'abc'), DownloadClientNotFoundError);
});

// ---------------------------------------------------------------------------
// annotateStalledStrikes
// ---------------------------------------------------------------------------

function torrent(over: Partial<StalledAnnotatable> = {}): StalledAnnotatable {
  return { hash: 'h1', progress: 0.5, state: 'downloading', ...over };
}

test('annotateStalledStrikes: no-op when stallConfig is null', async () => {
  const { service } = makeService();
  const items = [torrent()];
  await service.annotateStalledStrikes(items, null);
  assert.equal(items[0]?.stalledStrikes, undefined);
});

test('annotateStalledStrikes: skips items whose state is not stall-eligible', async () => {
  const { service } = makeService();
  const items = [torrent({ state: 'pausedDL' })];
  await service.annotateStalledStrikes(items, { samples: 3 });
  assert.equal(items[0]?.stalledStrikes, undefined);
});

test('annotateStalledStrikes: skips items already at 100% progress', async () => {
  const { service } = makeService();
  const items = [torrent({ progress: 1 })];
  await service.annotateStalledStrikes(items, { samples: 3 });
  assert.equal(items[0]?.stalledStrikes, undefined);
});

test('annotateStalledStrikes: fills strikes and the required count for an eligible item, clamped to samples', async () => {
  const { service } = makeService({
    stalledSnapshots: {
      findRecentForHashes: async () => [
        { torrentHash: 'h1', downloadedBytes: 1000, checkedAt: '3' },
        { torrentHash: 'h1', downloadedBytes: 1000, checkedAt: '2' },
        { torrentHash: 'h1', downloadedBytes: 1000, checkedAt: '1' },
        { torrentHash: 'h1', downloadedBytes: 1000, checkedAt: '0' },
      ],
    },
  });
  const items = [torrent({ hash: 'h1' })];
  await service.annotateStalledStrikes(items, { samples: 3 });
  assert.equal(items[0]?.stalledStrikes, 3); // 4 flat snapshots, clamped to samples=3
  assert.equal(items[0]?.stalledStrikesRequired, 3);
});

test('annotateStalledStrikes: does not query stalledSnapshots at all when nothing is eligible', async () => {
  let called = false;
  const { service } = makeService({ stalledSnapshots: { findRecentForHashes: async () => { called = true; return []; } } });
  await service.annotateStalledStrikes([torrent({ progress: 1 })], { samples: 3 });
  assert.equal(called, false);
});

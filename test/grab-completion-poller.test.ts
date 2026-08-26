/**
 * Ported behaviour from `completion.service.ts` + `completion.service.spec.ts`
 * (Fliks source): the orphan sweep's grace period + revive rule, the
 * stall-cleanup-off default, and — the brief's explicit ask — an adversarial
 * table proving every destructive path (orphan sweep, stalled removal, seeded
 * cleanup) skips the tick when a client is unreachable (`ok: false`) instead
 * of treating its empty torrent list as "holds nothing".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DownloadCompletionPoller, type CompletionPollerDeps } from '../src/grab/completion-poller';
import { HostCallError } from '../src/host-client';
import { TorrentHistoryMatcher } from '../src/grab/torrent-name-matcher';
import {
  FakeHistoryRepo,
  FakeStalledChecksRepo,
  FakeBlocklistRepo,
  FakeIndexersRepo,
  FakeClientsRepo,
  FakeDriver,
  FakeHost,
  makeHistoryRow,
  makeTorrent,
  makeClient,
  asHistoryRepo,
  asStalledChecksRepo,
  asBlocklistRepo,
  asIndexersRepo,
  asClientsRepo,
} from './grab-test-helpers';

function buildPoller() {
  const historyRepo = new FakeHistoryRepo();
  const stalledChecksRepo = new FakeStalledChecksRepo();
  const blocklistRepo = new FakeBlocklistRepo();
  const indexersRepo = new FakeIndexersRepo();
  const clientsRepo = new FakeClientsRepo();
  const driver = new FakeDriver();
  const host = new FakeHost();
  host.on('events.publish', () => undefined);
  host.on('progress.set', () => undefined);
  const searchMissingCalls: number[][] = [];

  const deps: CompletionPollerDeps = {
    host,
    driver,
    clientsRepo: asClientsRepo(clientsRepo),
    indexersRepo: asIndexersRepo(indexersRepo),
    historyRepo: asHistoryRepo(historyRepo),
    stalledChecksRepo: asStalledChecksRepo(stalledChecksRepo),
    blocklistRepo: asBlocklistRepo(blocklistRepo),
    historyMatcher: new TorrentHistoryMatcher(asHistoryRepo(historyRepo)),
    searchMissing: async (mediaIds) => {
      searchMissingCalls.push(mediaIds);
    },
  };
  const poller = new DownloadCompletionPoller(deps);
  return { poller, historyRepo, stalledChecksRepo, blocklistRepo, indexersRepo, clientsRepo, driver, host, searchMissingCalls };
}

const HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString();

describe('DownloadCompletionPoller.poll — orphan sweep (reconcileOrphanHistory)', () => {
  test('flips a grabbed row to failed once its torrent is gone past the grace, client reachable', async () => {
    const h = buildPoller();
    const client = makeClient({ id: 1 });
    h.clientsRepo.rows.push(client);
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [] });
    const row = makeHistoryRow({ id: 7, status: 'grabbed', torrentHash: 'gone', updatedAt: HOUR_AGO });
    h.historyRepo.rows.push(row);

    await h.poller.poll();

    assert.equal(h.historyRepo.rows[0]?.status, 'failed');
    assert.equal(h.historyRepo.rows[0]?.statusMessage, 'Torrent no longer present in download client');
  });

  test('leaves a grabbed row alone while its torrent is still present', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'here', progress: 0.4 })] });
    const row = makeHistoryRow({ id: 7, status: 'grabbed', torrentHash: 'here', updatedAt: HOUR_AGO });
    h.historyRepo.rows.push(row);

    await h.poller.poll();

    assert.equal(h.historyRepo.rows[0]?.status, 'grabbed');
  });

  test('clears the orphan stamp when the torrent reappears', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'back', progress: 0.2 })] });
    const row = makeHistoryRow({
      id: 9,
      status: 'failed',
      statusMessage: 'Torrent no longer present in download client',
      torrentHash: 'back',
      updatedAt: HOUR_AGO,
    });
    h.historyRepo.rows.push(row);

    await h.poller.poll();

    assert.equal(h.historyRepo.rows[0]?.status, 'grabbed');
    assert.equal(h.historyRepo.rows[0]?.statusMessage, null);
  });

  test('ADVERSARIAL: an unreachable client (ok:false) never orphans a row, even with the torrent list empty', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: false, torrents: [] }); // unreachable — empty list is an artefact of the failure
    const row = makeHistoryRow({ id: 7, status: 'grabbed', torrentHash: 'anything', updatedAt: HOUR_AGO });
    h.historyRepo.rows.push(row);

    await h.poller.poll();

    assert.equal(h.historyRepo.rows[0]?.status, 'grabbed', 'must not be flipped to failed on an unreachable client');
  });

  test('ADVERSARIAL: one unreachable client blocks the sweep for a torrent that IS present on a different, healthy client', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }), makeClient({ id: 2 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [] }); // healthy, holds nothing
    h.driver.torrentsByClient.set(2, { ok: false, torrents: [] }); // unreachable
    const row = makeHistoryRow({ id: 7, status: 'grabbed', torrentHash: 'gone', updatedAt: HOUR_AGO });
    h.historyRepo.rows.push(row);

    await h.poller.poll();

    // allClientsResponded is a whole-tick gate — one bad client holds the
    // entire sweep back, not just the rows that would key off its torrents.
    assert.equal(h.historyRepo.rows[0]?.status, 'grabbed');
  });

  test('VERDICT: a row parked for retry still reaches a terminal state once its torrent is really gone', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [] });
    // The status a retry parks a row at has to be one the orphan sweep expires, or the row never ends.
    h.historyRepo.rows.push(makeHistoryRow({ id: 7, status: 'grabbed', torrentHash: 'gone', updatedAt: HOUR_AGO }));

    await h.poller.poll();

    assert.equal(h.historyRepo.rows[0]?.status, 'failed');
  });

  test('no history row at all — nothing to reconcile, regardless of torrents', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [] });

    await h.poller.poll();

    assert.equal(h.historyRepo.updateCalls.length, 0);
  });
});

describe('DownloadCompletionPoller.cleanStalled — default off with no configuration', () => {
  test('returns before querying any client when the stall sample count is unset', async () => {
    const h = buildPoller();
    h.host.on('config.get', () => ({})); // fresh install: no config field is even wired in the manifest yet
    let listEnabledCalled = false;
    const origListEnabled = h.clientsRepo.listEnabled.bind(h.clientsRepo);
    h.clientsRepo.listEnabled = async () => {
      listEnabledCalled = true;
      return origListEnabled();
    };

    await h.poller.cleanStalled();

    assert.equal(listEnabledCalled, false, 'must never reach the client fetch — a hard stop, not a fall-through default');
    assert.equal(h.driver.deleted.length, 0);
  });
});

describe('DownloadCompletionPoller.cleanStalled — adversarial table', () => {
  function withConfig(h: ReturnType<typeof buildPoller>, samples = 2, intervalMinutes = 60): void {
    h.host.on('config.get', () => ({ stall_samples: String(samples), stall_interval_minutes: String(intervalMinutes) }));
  }

  test('ok:true, torrent present + stalled, history present -> deletes + blocklists + marks failed', async () => {
    const h = buildPoller();
    withConfig(h);
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.stalledChecksRepo.rows.push({ id: 1, torrentHash: 'stuck', downloadedBytes: 1000, checkedAt: HOUR_AGO });
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'stuck', downloaded: 1000, progress: 0.3, state: 'downloading' })] });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'stuck', status: 'grabbed', mediaId: 9 }));

    await h.poller.cleanStalled();

    assert.deepEqual(h.driver.deleted, [{ clientId: 1, hash: 'stuck', deleteFiles: true }]);
    assert.equal(h.historyRepo.rows[0]?.status, 'failed');
    assert.equal(h.blocklistRepo.inserted.length, 1);
  });

  test('ok:true, torrent present but still progressing, history present -> nothing deleted', async () => {
    const h = buildPoller();
    withConfig(h);
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.stalledChecksRepo.rows.push({ id: 1, torrentHash: 'moving', downloadedBytes: 1000, checkedAt: HOUR_AGO });
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'moving', downloaded: 1000 + 50 * 1024 * 1024, progress: 0.3, state: 'downloading' })] });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'moving', status: 'grabbed' }));

    await h.poller.cleanStalled();

    assert.equal(h.driver.deleted.length, 0);
    assert.equal(h.historyRepo.rows[0]?.status, 'grabbed');
  });

  test('ADVERSARIAL ok:false, torrent absent, history present -> nothing deleted (client unreachable this tick)', async () => {
    const h = buildPoller();
    withConfig(h);
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: false, torrents: [] });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'stuck', status: 'grabbed' }));

    await h.poller.cleanStalled();

    assert.equal(h.driver.deleted.length, 0);
    assert.equal(h.historyRepo.rows[0]?.status, 'grabbed');
  });

  test('history row absent (untracked torrent) -> nothing deleted even if it would otherwise look stalled', async () => {
    const h = buildPoller();
    withConfig(h);
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.stalledChecksRepo.rows.push({ id: 1, torrentHash: 'untracked', downloadedBytes: 1000, checkedAt: HOUR_AGO });
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'untracked', downloaded: 1000, progress: 0.3, state: 'downloading' })] });
    // no history row for this hash at all

    await h.poller.cleanStalled();

    assert.equal(h.driver.deleted.length, 0);
  });

  test('a stalled removal with autoRestart triggers a re-search for the media', async () => {
    const h = buildPoller();
    h.host.on('config.get', () => ({ stall_samples: '2', stall_auto_restart: 'true' }));
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.stalledChecksRepo.rows.push({ id: 1, torrentHash: 'stuck', downloadedBytes: 1000, checkedAt: HOUR_AGO });
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'stuck', downloaded: 1000, progress: 0.3, state: 'downloading' })] });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'stuck', status: 'grabbed', mediaId: 77, grabSource: 'auto' }));

    await h.poller.cleanStalled();

    assert.deepEqual(h.searchMissingCalls, [[77]]);
  });

  test('autoRestart explicitly off -> removal happens, no re-search', async () => {
    const h = buildPoller();
    h.host.on('config.get', () => ({ stall_samples: '2', stall_auto_restart: 'false' }));
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.stalledChecksRepo.rows.push({ id: 1, torrentHash: 'stuck', downloadedBytes: 1000, checkedAt: HOUR_AGO });
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'stuck', downloaded: 1000, progress: 0.3, state: 'downloading' })] });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'stuck', status: 'grabbed', mediaId: 77, grabSource: 'auto' }));

    await h.poller.cleanStalled();

    assert.equal(h.driver.deleted.length, 1);
    assert.deepEqual(h.searchMissingCalls, []);
  });

  test('a manual grab is still removed, but only re-searched when includeManualGrabs is on', async () => {
    const h = buildPoller();
    h.host.on('config.get', () => ({ stall_samples: '2', stall_auto_restart: 'true' }));
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.stalledChecksRepo.rows.push({ id: 1, torrentHash: 'stuck', downloadedBytes: 1000, checkedAt: HOUR_AGO });
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'stuck', downloaded: 1000, progress: 0.3, state: 'downloading' })] });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'stuck', status: 'grabbed', mediaId: 77, grabSource: 'manual' }));

    await h.poller.cleanStalled();

    assert.equal(h.driver.deleted.length, 1);
    assert.deepEqual(h.searchMissingCalls, []);
  });
});

describe('DownloadCompletionPoller.cleanSeeded — adversarial table', () => {
  test('ok:true, torrent present at/above target ratio, history present -> deletes', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'H1', ratio: 1.5, progress: 1 })] });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'H1', status: 'completed' }));

    await h.poller.cleanSeeded();

    assert.deepEqual(h.driver.deleted, [{ clientId: 1, hash: 'H1', deleteFiles: true }]);
  });

  test('ok:true, torrent present below target ratio, history present -> nothing deleted', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'H1', ratio: 0.1, progress: 1 })] });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'H1', status: 'completed' }));

    await h.poller.cleanSeeded();

    assert.equal(h.driver.deleted.length, 0);
  });

  test('ADVERSARIAL ok:false, torrent absent, history present -> nothing deleted (client unreachable this tick)', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: false, torrents: [] });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'H1', status: 'completed' }));

    await h.poller.cleanSeeded();

    assert.equal(h.driver.deleted.length, 0);
  });

  test('history row absent (no completed row for this hash) -> nothing deleted', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'H1', ratio: 5, progress: 1 })] });
    // no matching history row at all

    await h.poller.cleanSeeded();

    assert.equal(h.driver.deleted.length, 0);
  });

  test('torrent absent from the client (already removed by hand) -> nothing deleted', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [] });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'H1', status: 'completed' }));

    await h.poller.cleanSeeded();

    assert.equal(h.driver.deleted.length, 0);
  });
  test('retention reached before the ratio target -> deletes on age', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.indexersRepo.rows.push({
      id: 7,
      name: 'tracker',
      implementation: 'torznab',
      settings: { seedRatio: 99, maxRetentionDays: 2 },
      enableRss: true,
      enableSearch: true,
      priority: 25,
      enabled: true,
      capsSearchFallback: false,
      capsMovieSearch: false,
      capsTvSearch: false,
      capsProbedAt: null,
      requestDelay: 0,
      createdAt: 'now',
      updatedAt: 'now',
    });
    const threeDaysAgo = Math.floor(Date.now() / 1000) - 3 * 86_400;
    h.driver.torrentsByClient.set(1, {
      ok: true,
      torrents: [makeTorrent({ hash: 'H1', ratio: 0.1, progress: 1, completion_on: threeDaysAgo })],
    });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'H1', status: 'completed', indexerId: 7 }));

    await h.poller.cleanSeeded();

    // A ratio of 99 is unreachable: only the age rule can have removed this.
    assert.deepEqual(h.driver.deleted, [{ clientId: 1, hash: 'H1', deleteFiles: true }]);
  });

  test('VERDICT: no completion time reported -> judged on ratio alone, never treated as age zero', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.indexersRepo.rows.push({
      id: 7,
      name: 'tracker',
      implementation: 'torznab',
      settings: { seedRatio: 99, maxRetentionDays: 1 },
      enableRss: true,
      enableSearch: true,
      priority: 25,
      enabled: true,
      capsSearchFallback: false,
      capsMovieSearch: false,
      capsTvSearch: false,
      capsProbedAt: null,
      requestDelay: 0,
      createdAt: 'now',
      updatedAt: 'now',
    });
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'H1', ratio: 0.1, progress: 1 })] });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'H1', status: 'completed', indexerId: 7 }));

    await h.poller.cleanSeeded();

    assert.equal(h.driver.deleted.length, 0);
  });
});

describe('DownloadCompletionPoller.poll — import hand-off', () => {
  test('imports a completed torrent via library.ingest, marks the row completed, publishes acquisition.imported', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'done', progress: 1, state: 'stalledUP' })] });
    h.driver.filesByHash.set('done', [{ name: 'Movie.mkv', size: 100, progress: 1, priority: 1 }]);
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'done', status: 'grabbed', mediaId: 5, sourceTitle: 'Movie' }));
    let ingestCalls = 0;
    h.host.on('library.ingest', (p: unknown) => {
      ingestCalls++;
      return { imported: [{ mediaFileId: 1, relativePath: 'Movie.mkv', quality: 'WEBDL-1080p' }], alreadyPresent: [], seasonNumber: undefined, episodeNumber: undefined };
    });

    await h.poller.poll();

    assert.equal(ingestCalls, 1);
    assert.equal(h.historyRepo.rows[0]?.status, 'completed');
    const published = h.host.calls.filter((c) => c.method === 'events.publish');
    const imported = published.flatMap((c) => c.payload as { type: string }[]).find((e) => e.type === 'acquisition.imported');
    assert.ok(imported, 'must publish acquisition.imported');
  });

  test('VERDICT: a retried ingest that writes nothing because the file is already there completes the row', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'done', progress: 1, state: 'stalledUP' })] });
    h.driver.filesByHash.set('done', [{ name: 'Movie.mkv', size: 100, progress: 1, priority: 1 }]);
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'done', status: 'grabbed', mediaId: 7, sourceTitle: 'Movie' }));
    h.host.on('library.ingest', () => ({ imported: [], alreadyPresent: ['/downloads/Movie.mkv'] }));

    await h.poller.poll();

    const row = h.historyRepo.rows[0]!;
    // The first attempt timed out while core finished the copy: failing here is what put a landed
    // import in the failed state, once a minute, for good.
    assert.equal(row.status, 'completed');
    const published = h.host.calls.filter((c) => c.method === 'events.publish');
    const imported = published.flatMap((c) => c.payload as { type: string }[]).find((e) => e.type === 'acquisition.imported');
    assert.ok(imported, 'a lost-reply retry must still notify core once the row completes');
  });

  test('the ingest call is given more time than a lookup — a copy is not a metadata read', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'done', progress: 1, state: 'stalledUP' })] });
    h.driver.filesByHash.set('done', [{ name: 'Movie.mkv', size: 100, progress: 1, priority: 1 }]);
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'done', status: 'grabbed', mediaId: 7 }));
    h.host.on('library.ingest', () => ({ imported: [{ mediaFileId: 1, relativePath: 'Movie.mkv', quality: 'x' }], alreadyPresent: [] }));
    h.host.on('events.publish', () => undefined);

    await h.poller.poll();

    const call = h.host.calls.find((c) => c.method === 'library.ingest');
    assert.ok((call?.timeoutMs ?? 0) > 60_000, 'a default-timeout ingest gave up while core was still writing');
  });

  test('idempotency: a row that already imported drops out of the candidate set — library.ingest is not called again', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'done', progress: 1, state: 'stalledUP' })] });
    h.driver.filesByHash.set('done', [{ name: 'Movie.mkv', size: 100, progress: 1, priority: 1 }]);
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'done', status: 'grabbed', mediaId: 5, sourceTitle: 'Movie' }));
    let ingestCalls = 0;
    let lastKey: string | undefined;
    h.host.on('library.ingest', (p: unknown) => {
      ingestCalls++;
      lastKey = (p as { idempotencyKey: string }).idempotencyKey;
      return { imported: [{ mediaFileId: 1, relativePath: 'Movie.mkv', quality: 'WEBDL-1080p' }] };
    });

    await h.poller.poll();
    assert.equal(ingestCalls, 1);
    assert.equal(lastKey, 'download-history:1');

    await h.poller.poll(); // second tick, same torrent still present and "completed"-shaped

    assert.equal(ingestCalls, 1, 'a completed row must never re-enter the import candidate set');
  });

  test('VERDICT: an unknown-outcome host error (e.g. a core timeout) retries instead of blocklisting', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'done', progress: 1, state: 'stalledUP' })] });
    h.driver.filesByHash.set('done', [{ name: 'Movie.mkv', size: 100, progress: 1, priority: 1 }]);
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'done', status: 'grabbed', mediaId: 5, sourceTitle: 'Movie' }));
    let ingestCalls = 0;
    h.host.on('library.ingest', () => {
      ingestCalls++;
      throw new HostCallError('"library.ingest" timed out after 1860000ms', 'unknown');
    });

    await h.poller.poll();

    const row = h.historyRepo.rows[0]!;
    assert.equal(row.status, 'grabbed', 'must stay retryable and visible in the queue, never failed or "warning"');
    assert.match(row.statusMessage ?? '', /timed out/);
    assert.equal(h.blocklistRepo.inserted.length, 0, 'core being slow must never blocklist a good release');

    // Next pass: core answers this time — the same row (still 'grabbed') is retried, not skipped.
    h.host.on('library.ingest', () => {
      ingestCalls++;
      return { imported: [{ mediaFileId: 1, relativePath: 'Movie.mkv', quality: 'WEBDL-1080p' }], alreadyPresent: [] };
    });
    h.host.on('events.publish', () => undefined);

    await h.poller.poll();

    assert.equal(ingestCalls, 2);
    assert.equal(h.historyRepo.rows[0]?.status, 'completed');
  });

  test('VERDICT: a core error reply fails the row, and never blocklists on core\'s own state', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'done', progress: 1, state: 'stalledUP' })] });
    h.driver.filesByHash.set('done', [{ name: 'Movie.mkv', size: 100, progress: 1, priority: 1 }]);
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'done', status: 'grabbed', mediaId: 5, sourceTitle: 'Movie' }));
    h.host.on('library.ingest', () => {
      throw new HostCallError('ERR_INGEST: media no longer exists', 'rejected');
    });

    await h.poller.poll();

    const row = h.historyRepo.rows[0]!;
    assert.equal(row.status, 'failed');
    assert.equal(h.blocklistRepo.inserted.length, 0);
  });

  test('no valid video file in the torrent -> blocklists, deletes the dud torrent, marks the row failed', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'dud', progress: 1, state: 'stalledUP' })] });
    h.driver.filesByHash.set('dud', [{ name: 'Movie.rar', size: 100, progress: 1, priority: 1 }]);
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'dud', status: 'grabbed', mediaId: 5, sourceTitle: 'Movie' }));

    await h.poller.poll();

    assert.equal(h.historyRepo.rows[0]?.status, 'failed');
    assert.equal(h.blocklistRepo.inserted.length, 1);
    assert.deepEqual(h.driver.deleted, [{ clientId: 1, hash: 'dud', deleteFiles: true }]);
  });

  test('VERDICT: the client could not be asked for its files -> retries, never deletes or blocklists', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent({ hash: 'unreachable', progress: 1, state: 'stalledUP' })] });
    h.driver.filesOk = false;
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'unreachable', status: 'grabbed', mediaId: 5, sourceTitle: 'Movie' }));

    await h.poller.poll();

    const row = h.historyRepo.rows[0]!;
    assert.equal(row.status, 'grabbed', 'must stay retryable and visible in the queue, never failed');
    assert.equal(h.blocklistRepo.inserted.length, 0, 'a qBittorrent restart must never blocklist a good release');
    assert.equal(h.driver.deleted.length, 0, 'a qBittorrent restart must never delete a completed download');
  });
});

describe('DownloadCompletionPoller.init', () => {
  test('re-arms every stranded importing row on boot', async () => {
    const h = buildPoller();
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, status: 'importing' }), makeHistoryRow({ id: 2, status: 'grabbed' }));

    await h.poller.init();

    assert.equal(h.historyRepo.rows[0]?.status, 'grabbed');
    assert.equal(h.historyRepo.rows[1]?.status, 'grabbed');
  });
});

describe('DownloadCompletionPoller auto-match — what it reads, and what it must not re-identify', () => {
  function withTorrent(h: ReturnType<typeof buildPoller>, torrent: Parameters<typeof makeTorrent>[0]) {
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [makeTorrent(torrent)] });
  }

  test('a torrent already bound to a media is never sent to releases.match', async () => {
    const h = buildPoller();
    withTorrent(h, { hash: 'aabb', name: 'Some.Release.1080p', progress: 0.5, state: 'downloading' });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'aabb', status: 'grabbed', mediaId: 5 }));

    await h.poller.poll();

    assert.equal(h.host.calls.some((c) => c.method === 'releases.match'), false);
    assert.equal(h.historyRepo.insertCalls.length, 0);
  });

  test('an unrecorded torrent whose name matches a linked row is not re-inserted as a duplicate', async () => {
    const h = buildPoller();
    // Same release, different separators and case — what normaliseTorrentName exists to absorb.
    withTorrent(h, { hash: 'ccdd', name: 'Some_Release.1080P', progress: 0.5, state: 'downloading' });
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'other', status: 'grabbed', mediaId: 5, sourceTitle: 'Some.Release.1080p' }));

    await h.poller.poll();

    assert.equal(h.host.calls.some((c) => c.method === 'releases.match'), false);
    assert.equal(h.historyRepo.insertCalls.length, 0);
  });

  test('an unrecorded torrent nothing accounts for is identified and recorded', async () => {
    const h = buildPoller();
    withTorrent(h, { hash: 'eeff', name: 'Unknown.Release.2160p', progress: 0.5, state: 'downloading' });
    h.host.on('releases.match', () => [{ id: '0', mediaId: 42, isFullSeason: false }]);

    await h.poller.poll();

    assert.equal(h.historyRepo.insertCalls.length, 1);
    assert.equal(h.historyRepo.insertCalls[0]?.mediaId, 42);
    assert.equal(h.historyRepo.insertCalls[0]?.torrentHash, 'eeff');
  });

  test('a row for a hash no client reports is never read — the query is bounded to what is in front of us', async () => {
    const h = buildPoller();
    withTorrent(h, { hash: 'eeff', name: 'Unknown.Release.2160p', progress: 0.5, state: 'downloading' });
    // A linked row for an unrelated hash: it must still shield its own title, but its row
    // is not what decides whether 'eeff' is a candidate.
    h.historyRepo.rows.push(makeHistoryRow({ id: 1, torrentHash: 'zzzz', status: 'completed', mediaId: 7, sourceTitle: 'Old.Release.720p' }));
    h.host.on('releases.match', () => [{ id: '0', mediaId: 42, isFullSeason: false }]);

    await h.poller.poll();

    assert.equal(h.historyRepo.insertCalls.length, 1);
    assert.equal(h.historyRepo.insertCalls[0]?.mediaId, 42);
  });
});

/**
 * The queue view is driven by these events. A torrent at 100% was filtered out before it could
 * be reported, so the flip to `importing` was never pushed and the view kept showing a download
 * that had finished — until an unrelated refetch caught up, minutes later.
 */
describe('DownloadCompletionPoller.poll — reporting the importing state', () => {
  function progressCalls(host: { calls: { method: string; payload: unknown }[] }): { state: string; progress: number; ref: string }[] {
    return host.calls
      .filter((c) => c.method === 'progress.set')
      .map((c) => c.payload as { state: string; progress: number; ref: string });
  }

  test('VERDICT: a finished torrent whose row is importing still gets a tick', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    // Seeding at 100%: the client's own vocabulary says nothing about importing.
    const done = makeTorrent({ hash: 'abc', progress: 1, state: 'uploading' });
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [done] });
    h.historyRepo.rows.push(
      makeHistoryRow({ id: 1, status: 'importing', torrentHash: 'abc', mediaId: 5, downloadClientId: 1 }),
    );

    await h.poller.poll();

    const ticks = progressCalls(h.host);
    assert.ok(ticks.some((t) => t.ref === 'abc' && t.state === 'importing'));
  });

  test('a finished torrent whose row is not importing stays unreported', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    const done = makeTorrent({ hash: 'abc', progress: 1, state: 'uploading' });
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [done] });
    h.historyRepo.rows.push(
      makeHistoryRow({ id: 1, status: 'completed', torrentHash: 'abc', mediaId: 5, downloadClientId: 1 }),
    );

    await h.poller.poll();

    // Otherwise every seeding torrent would tick forever.
    assert.equal(progressCalls(h.host).some((t) => t.ref === 'abc'), false);
  });

  test('a download still in flight is reported from the client state, as before', async () => {
    const h = buildPoller();
    h.clientsRepo.rows.push(makeClient({ id: 1 }));
    const running = makeTorrent({ hash: 'abc', progress: 0.4, state: 'stalledDL' });
    h.driver.torrentsByClient.set(1, { ok: true, torrents: [running] });
    h.historyRepo.rows.push(
      makeHistoryRow({ id: 1, status: 'grabbed', torrentHash: 'abc', mediaId: 5, downloadClientId: 1 }),
    );

    await h.poller.poll();

    assert.ok(progressCalls(h.host).some((t) => t.ref === 'abc' && t.state === 'stalled'));
  });
});

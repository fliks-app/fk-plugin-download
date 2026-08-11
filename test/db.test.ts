/**
 * Runs for real against `fliks-migtest` (127.0.0.1:55432) — never the Fliks dev
 * database on 5434. Skips every test (does not fail) when that database is
 * unreachable, so `npm test` stays green in an environment with no Postgres.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { isDatabaseReachable, adminPool, MIGTEST_DSN } from './db-test-helpers';
import { createPluginPool, pluginSchemaName } from '../src/db/pool';
import { migrateUp, migrateDown } from '../src/db/migrate';
import { createRepositories, type Repositories } from '../src/db/repositories';

const PLUGIN_ID = 'test.download';
const SCHEMA = pluginSchemaName(PLUGIN_ID);
const SIX_TABLES = ['indexers', 'download_clients', 'indexer_stats', 'download_history', 'blocklist', 'stalled_checks'];

let reachable = false;
let admin: Pool;
let pool: Pool;
let repos: Repositories;

before(async () => {
  reachable = await isDatabaseReachable();
  if (!reachable) return;
  admin = adminPool();
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
  pool = createPluginPool({ dsn: MIGTEST_DSN, pluginId: PLUGIN_ID });
  await migrateUp(pool);
  repos = createRepositories(pool);
});

after(async () => {
  if (!reachable) return;
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.end();
});

async function tableNames(p: Pool, schema: string): Promise<string[]> {
  const { rows } = await p.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
    [schema],
  );
  return rows.map((r) => r.table_name);
}

test('migrateUp -> migrateDown -> migrateUp, in its own throwaway schema', async (t) => {
  if (!reachable) {
    t.skip('fliks-migtest not reachable on 127.0.0.1:55432');
    return;
  }
  const udoPluginId = 'test.download.udu';
  const udoSchema = pluginSchemaName(udoPluginId);
  await admin.query(`DROP SCHEMA IF EXISTS "${udoSchema}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${udoSchema}"`);
  const udoPool = createPluginPool({ dsn: MIGTEST_DSN, pluginId: udoPluginId });
  try {
    const ranUp1 = await migrateUp(udoPool);
    console.log('[up#1]', ranUp1);
    assert.deepEqual(ranUp1, ['0001_initial_schema']);
    assert.deepEqual(await tableNames(udoPool, udoSchema), ['_migrations', ...SIX_TABLES].sort());

    const ranUpAgain = await migrateUp(udoPool);
    console.log('[up-again, idempotent]', ranUpAgain);
    assert.deepEqual(ranUpAgain, [], 'a second up must apply nothing');

    const ranDown = await migrateDown(udoPool, 1);
    console.log('[down]', ranDown);
    assert.deepEqual(ranDown, ['0001_initial_schema']);
    assert.deepEqual(await tableNames(udoPool, udoSchema), ['_migrations'], 'only the tracking table survives a down');

    const ranUp2 = await migrateUp(udoPool);
    console.log('[up#2]', ranUp2);
    assert.deepEqual(ranUp2, ['0001_initial_schema']);
    assert.deepEqual(await tableNames(udoPool, udoSchema), ['_migrations', ...SIX_TABLES].sort());
  } finally {
    await udoPool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${udoSchema}" CASCADE`);
  }
});

test('migrated columns match the Fliks-originals in public, modulo the two declared departures', async (t) => {
  if (!reachable) {
    t.skip('fliks-migtest not reachable on 127.0.0.1:55432');
    return;
  }
  interface ColumnRow {
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }
  const query = `
    SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = ANY($2::text[])
     ORDER BY table_name, column_name`;
  const mine = (await admin.query<ColumnRow>(query, [SCHEMA, SIX_TABLES])).rows;
  const originals = (await admin.query<ColumnRow>(query, ['public', SIX_TABLES])).rows;

  // Expected departure #1: every timestamp is timestamptz on the new tables;
  // `indexer_stats.queryDate` and `stalled_checks.checkedAt` are bare `timestamp` on the originals.
  const TZ_DEPARTURES = new Set(['indexer_stats.queryDate', 'stalled_checks.checkedAt']);

  const key = (r: ColumnRow) => `${r.table_name}.${r.column_name}`;
  const originalByKey = new Map(originals.map((r) => [key(r), r]));
  const diffs: string[] = [];

  for (const row of mine) {
    const orig = originalByKey.get(key(row));
    if (!orig) {
      diffs.push(`${key(row)}: present in "${SCHEMA}" but missing from "public"`);
      continue;
    }
    if (row.is_nullable !== orig.is_nullable) {
      diffs.push(`${key(row)}: nullable ${row.is_nullable} vs original ${orig.is_nullable}`);
    }
    if (row.data_type !== orig.data_type) {
      if (TZ_DEPARTURES.has(key(row)) && row.data_type === 'timestamp with time zone' && orig.data_type === 'timestamp without time zone') {
        continue; // the declared departure
      }
      diffs.push(`${key(row)}: type "${row.data_type}" vs original "${orig.data_type}"`);
    }
  }
  for (const orig of originals) {
    if (!mine.some((r) => key(r) === key(orig))) diffs.push(`${key(orig)}: present in "public" but missing from "${SCHEMA}"`);
  }

  console.log('[column diff vs originals]', diffs.length === 0 ? '(none beyond the declared timestamptz departure)' : diffs);
  assert.deepEqual(diffs, []);
});

test('cross-schema FK delete actions match the originals exactly', async (t) => {
  if (!reachable) {
    t.skip('fliks-migtest not reachable on 127.0.0.1:55432');
    return;
  }
  interface FkRow {
    table_name: string;
    column: string;
    confdeltype: string;
  }
  const query = `
    SELECT conrelid::regclass::text AS table_name,
           (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) AS "column",
           c.confdeltype
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname = $1 AND c.contype = 'f' AND conrelid::regclass::text = ANY($2::text[])
     ORDER BY table_name, "column"`;
  const mine = (await admin.query<FkRow>(query, [SCHEMA, SIX_TABLES])).rows;
  const originals = (await admin.query<FkRow>(query, ['public', SIX_TABLES])).rows;

  const key = (r: FkRow) => `${r.table_name}.${r.column}`;
  const originalByKey = new Map(originals.map((r) => [key(r), r.confdeltype]));
  const diffs: string[] = [];
  for (const row of mine) {
    const origDelType = originalByKey.get(key(row));
    if (origDelType === undefined) {
      diffs.push(`${key(row)}: FK exists here but not on the original (or the original FK was dropped, e.g. blocklist.indexerId)`);
      continue;
    }
    if (origDelType !== row.confdeltype) diffs.push(`${key(row)}: ON DELETE "${row.confdeltype}" vs original "${origDelType}"`);
  }
  console.log('[FK delete-action diff vs originals]', diffs.length === 0 ? '(none)' : diffs);
  assert.deepEqual(diffs, []);

  // blocklist.indexerId has no FK on either side (dropped by 1782700000000-drop-blocklist-indexer-fk.ts).
  const mineKeys = new Set(mine.map(key));
  assert.equal(mineKeys.has('blocklist.indexerId'), false);
});

test('stalled_checks.downloadedBytes round-trips a value above 2^31 as a JS number, losslessly', async (t) => {
  if (!reachable) {
    t.skip('fliks-migtest not reachable on 127.0.0.1:55432');
    return;
  }
  const ABOVE_2_31 = 5_000_000_000; // 5 GB; 2^31 = 2_147_483_648
  assert.ok(ABOVE_2_31 > 2 ** 31);

  const inserted = await repos.stalledChecks.insert('deadbeef'.repeat(5).slice(0, 40), ABOVE_2_31);
  assert.equal(typeof inserted.downloadedBytes, 'number');
  assert.equal(inserted.downloadedBytes, ABOVE_2_31);

  const latest = await repos.stalledChecks.findLatest(inserted.torrentHash);
  assert.equal(typeof latest?.downloadedBytes, 'number');
  assert.equal(latest?.downloadedBytes, ABOVE_2_31);

  // Also prove the raw driver would have handed back a string, absent the type override —
  // i.e. this is the pool's OID-20 parser doing the work, not a coincidence of a small value.
  const raw = await pool.query('SELECT pg_typeof("downloadedBytes")::text AS t FROM "stalled_checks" WHERE id = $1', [
    inserted.id,
  ]);
  assert.equal(raw.rows[0].t, 'bigint');
});

test('indexers repository: insert, findById, refreshCaps, markSearchFallback, update, remove', async () => {
  if (!reachable) return;
  const created = await repos.indexers.insert({
    name: 'Test Indexer',
    implementation: 'torznab',
    settings: { baseUrl: 'https://example.invalid', apiKey: 'x' },
    enableRss: true,
    enableSearch: true,
    priority: 25,
    requestDelay: 2,
    enabled: true,
  });
  assert.equal(created.capsMovieSearch, false);

  const found = await repos.indexers.findById(created.id);
  assert.equal(found?.name, 'Test Indexer');

  await repos.indexers.refreshCaps(created.id, { capsMovieSearch: true, capsTvSearch: false, capsSearchFallback: false });
  assert.equal((await repos.indexers.findById(created.id))?.capsMovieSearch, true);

  await repos.indexers.markSearchFallback(created.id);
  assert.equal((await repos.indexers.findById(created.id))?.capsSearchFallback, true);

  const updated = await repos.indexers.update(created.id, {
    name: 'Renamed',
    implementation: 'torznab',
    settings: created.settings,
    enableRss: false,
    enableSearch: true,
    priority: 10,
    requestDelay: 5,
    enabled: false,
  });
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.enableRss, false);

  const enabledList = await repos.indexers.listEnabled();
  assert.ok(!enabledList.some((i) => i.id === created.id), 'disabled indexer must not appear in listEnabled');

  await repos.indexers.remove(created.id);
  assert.equal(await repos.indexers.findById(created.id), null);
});

test('indexer_stats repository: insert and dailyStats aggregation', async () => {
  if (!reachable) return;
  const indexer = await repos.indexers.insert({
    name: 'Stats Indexer',
    implementation: 'torznab',
    settings: {},
    enableRss: true,
    enableSearch: true,
    priority: 25,
    requestDelay: 2,
    enabled: true,
  });
  await repos.indexerStats.insert({ indexerId: indexer.id, queryType: 'search', responseTimeMs: 120, resultCount: 5, errorMessage: null });
  await repos.indexerStats.insert({ indexerId: indexer.id, queryType: 'search', responseTimeMs: 80, resultCount: 0, errorMessage: 'boom' });

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const stats = await repos.indexerStats.dailyStats(indexer.id, since);
  assert.equal(stats.length, 1);
  assert.equal(stats[0]?.queries, 2);
  assert.equal(stats[0]?.errors, 1);
  assert.equal(stats[0]?.totalResults, 5);

  await repos.indexers.remove(indexer.id); // FK is ON DELETE CASCADE — takes the two stat rows with it
  const statsAfter = await repos.indexerStats.dailyStats(indexer.id, since);
  assert.equal(statsAfter.length, 0);
});

test('download_clients repository: insert, listAll, update, remove', async () => {
  if (!reachable) return;
  const created = await repos.downloadClients.insert({
    name: 'qBit',
    implementation: 'qbittorrent',
    settings: { host: 'localhost' },
    enabled: true,
    priority: 1,
  });
  assert.ok((await repos.downloadClients.listAll()).some((c) => c.id === created.id));

  const updated = await repos.downloadClients.update(created.id, { ...created, enabled: false });
  assert.equal(updated.enabled, false);
  assert.ok(!(await repos.downloadClients.listEnabled()).some((c) => c.id === created.id));

  await repos.downloadClients.remove(created.id);
  assert.equal(await repos.downloadClients.findById(created.id), null);
});

test('download_history repository: insertGrab, status transitions, completeImport, healMatch', async () => {
  if (!reachable) return;
  const media = await admin.query<{ id: number }>(`INSERT INTO public.media ("title", "type") VALUES ($1, 'movie') RETURNING id`, [
    'DB Repo Test Media',
  ]);
  const mediaId = media.rows[0]!.id;
  try {
    const grab = await repos.downloadHistory.insertGrab({
      sourceTitle: 'Some.Movie.1080p',
      quality: '1080p',
      grabSource: 'auto',
      mediaId,
    });
    assert.equal(grab.status, 'grabbed');

    const pending = await repos.downloadHistory.findPendingGrabForMedia(mediaId);
    assert.equal(pending?.id, grab.id);

    await repos.downloadHistory.markImporting(grab.id);
    const byStatus = await repos.downloadHistory.findByStatuses(['importing']);
    assert.ok(byStatus.some((r) => r.id === grab.id));

    await repos.downloadHistory.completeImport(grab.id);
    const active = await repos.downloadHistory.countActive();
    assert.equal(active, 0);

    await repos.downloadHistory.healMatch(grab.id, { mediaId, episodeId: null, seasonId: null, quality: '2160p' });
    const all = await repos.downloadHistory.findAll();
    assert.equal(all.find((r) => r.id === grab.id)?.quality, '2160p');

    await repos.downloadHistory.markFailed(grab.id, 'boom');
    assert.equal((await repos.downloadHistory.findAll()).find((r) => r.id === grab.id)?.status, 'failed');
  } finally {
    await admin.query(`DELETE FROM public.media WHERE id = $1`, [mediaId]);
  }
});

test('blocklist repository: insert, isBlocked case-insensitivity, list, remove, clear', async () => {
  if (!reachable) return;
  const entry = await repos.blocklist.insert({ sourceTitle: 'Blocked.Release.2024' });
  assert.equal(await repos.blocklist.isBlocked('BLOCKED.RELEASE.2024'), true);
  assert.equal(await repos.blocklist.isBlocked('not-there'), false);

  const { items, total } = await repos.blocklist.list(10, 0);
  assert.ok(total >= 1);
  assert.ok(items.some((i) => i.id === entry.id));

  await repos.blocklist.remove(entry.id);
  assert.equal(await repos.blocklist.findById(entry.id), null);

  await repos.blocklist.insert({ sourceTitle: 'Another.Release' });
  await repos.blocklist.clear();
  assert.equal((await repos.blocklist.list(10, 0)).total, 0);
});

/** Coverage-aware pending-grab dedup, run against the real SQL predicate in `fliks-migtest`
 *  (see `db-test-helpers.ts`). Skips when that database is unreachable. */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { isDatabaseReachable, adminPool, MIGTEST_DSN } from './db-test-helpers';
import { createPluginPool, pluginSchemaName } from '../src/db/pool';
import { migrateUp, migrateDown } from '../src/db/migrate';
import { MIGRATIONS } from '../migrations';
import { createRepositories, type Repositories } from '../src/db/repositories';
import { toCoverageColumns } from '../src/grab/grab-history';
import type { ReleaseCoverage } from '../src/host-methods';

const PLUGIN_ID = 'test.download.coverage';
const SCHEMA = pluginSchemaName(PLUGIN_ID);

let reachable = false;
let admin: Pool;
let pool: Pool;
let repos: Repositories;
let mediaId = 0;

before(async () => {
  reachable = await isDatabaseReachable();
  if (!reachable) return;
  admin = adminPool();
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
  pool = createPluginPool({ dsn: MIGTEST_DSN, pluginId: PLUGIN_ID });
  await migrateUp(pool);
  repos = createRepositories(pool);
  mediaId = (await admin.query<{ id: number }>(`INSERT INTO public.media ("title", "type") VALUES ('Coverage Test', 'series') RETURNING id`)).rows[0]!.id;
  await admin.query(`INSERT INTO public.seasons ("id") SELECT 100 + n FROM generate_series(1, 9) n ON CONFLICT DO NOTHING`);
  await admin.query(`INSERT INTO public.episodes ("id") SELECT 500 + n FROM generate_series(1, 9) n ON CONFLICT DO NOTHING`);
});

after(async () => {
  if (!reachable) return;
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.query(`DELETE FROM public.media WHERE id = $1`, [mediaId]);
  await admin.query(`DELETE FROM public.seasons WHERE id BETWEEN 101 AND 109`);
  await admin.query(`DELETE FROM public.episodes WHERE id BETWEEN 501 AND 509`);
  await admin.end();
});

async function grab(sourceTitle: string, opts: { coverage?: ReleaseCoverage; seasonId?: number | null; episodeId?: number | null; status?: 'importing' | 'completed' } = {}): Promise<void> {
  const row = await repos.downloadHistory.insertGrab({
    sourceTitle,
    quality: '1080p',
    grabSource: 'auto',
    mediaId,
    seasonId: opts.seasonId ?? null,
    episodeId: opts.episodeId ?? null,
    coverage: toCoverageColumns(opts.coverage),
  });
  if (opts.status === 'importing') await repos.downloadHistory.markImporting(row.id);
  if (opts.status === 'completed') await repos.downloadHistory.completeImport(row.id);
}

async function clear(): Promise<void> {
  await pool.query(`DELETE FROM "download_history"`);
}

/** Season `s` (id = 100 + s), optionally an episode. */
async function pending(season: number, episode: number | null = null): Promise<boolean> {
  return (await repos.downloadHistory.findPendingGrabCovering({
    mediaId,
    seasonId: 100 + season,
    seasonNumber: season,
    episodeNumber: episode,
    episodeTagPattern: episode == null ? null : `%S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}%`,
  })) !== null;
}

const seasons = (from: number, to: number, episodes: ReleaseCoverage['episodes'] = null): ReleaseCoverage => ({ seasons: { from, to }, episodes, completeSeries: false });

describe('findPendingGrabCovering', () => {
  test('a multi-season pack blocks every season in range and their episodes, not the ones outside', async (t) => {
    if (!reachable) return t.skip('fliks-migtest not reachable');
    await clear();
    await grab('Show.S01-S04.1080p', { coverage: seasons(1, 4), seasonId: 101 });
    for (const s of [1, 2, 3, 4]) {
      assert.equal(await pending(s), true, `season ${s}`);
      assert.equal(await pending(s, 5), true, `episode S${s}E05`);
    }
    assert.equal(await pending(5), false);
    assert.equal(await pending(5, 1), false);
  });

  test('a complete-series release blocks every season and episode', async (t) => {
    if (!reachable) return t.skip('fliks-migtest not reachable');
    await clear();
    await grab('Show.Complete.Series.1080p', { coverage: { seasons: null, episodes: null, completeSeries: true }, seasonId: 101 });
    assert.equal(await pending(1), true);
    assert.equal(await pending(9), true);
    assert.equal(await pending(9, 12), true);
    assert.equal(await pending(0), false, 'specials are not part of a complete series');
    assert.equal(await pending(0, 1), false);
  });

  test('a multi-episode file blocks each of its episodes and nothing else', async (t) => {
    if (!reachable) return t.skip('fliks-migtest not reachable');
    await clear();
    await grab('Show.S01E04E05.1080p', { coverage: seasons(1, 1, { from: 4, to: 5 }), seasonId: 101 });
    assert.equal(await pending(1, 4), true);
    assert.equal(await pending(1, 5), true);
    assert.equal(await pending(1, 3), false);
    assert.equal(await pending(1, 6), false);
    assert.equal(await pending(2, 5), false, 'same episode number in another season');
  });

  test('a pending single episode never blocks its season target', async (t) => {
    if (!reachable) return t.skip('fliks-migtest not reachable');
    await clear();
    await grab('Show.S01E05.1080p', { coverage: seasons(1, 1, { from: 5, to: 5 }), seasonId: 101 });
    assert.equal(await pending(1), false);
    assert.equal(await pending(1, 5), true);
  });

  test('a season pack blocks its season and episodes through coverage alone', async (t) => {
    if (!reachable) return t.skip('fliks-migtest not reachable');
    await clear();
    // seasonId deliberately absent: only the recorded coverage can answer.
    await grab('Show.S02.1080p', { coverage: seasons(2, 2) });
    assert.equal(await pending(2), true);
    assert.equal(await pending(2, 7), true);
    assert.equal(await pending(1), false);
  });

  test('importing counts as pending; completed and failed do not', async (t) => {
    if (!reachable) return t.skip('fliks-migtest not reachable');
    await clear();
    await grab('Show.S03.1080p', { coverage: seasons(3, 3), status: 'importing' });
    assert.equal(await pending(3), true);
    await clear();
    await grab('Show.S03.1080p', { coverage: seasons(3, 3), status: 'completed' });
    assert.equal(await pending(3), false);
  });

  test('rows without coverage keep the seasonId and source-title checks', async (t) => {
    if (!reachable) return t.skip('fliks-migtest not reachable');
    await clear();
    await grab('Show.S01.1080p', { seasonId: 101 });
    assert.equal(await pending(1), true, 'pack row matched by seasonId');
    assert.equal(await pending(1, 3), true, 'and it covers the season\'s episodes');
    assert.equal(await pending(2), false);

    await clear();
    await grab('Show.S01E05.1080p', { seasonId: 101, episodeId: 501 });
    assert.equal(await pending(1, 5), true, 'matched by the episode tag');
    assert.equal(await pending(1, 6), false);
    assert.equal(await pending(1), false, 'a single episode does not block the season');

    await clear();
    await grab('Show.S01E04E05.1080p', { seasonId: 101, episodeId: 504 });
    assert.equal(await pending(1, 5), false, 'legacy limit: the tag pattern misses E04E05');
  });

  test('known coverage is authoritative over the legacy checks', async (t) => {
    if (!reachable) return t.skip('fliks-migtest not reachable');
    await clear();
    // Title and seasonId say S01, coverage says S03: coverage wins.
    await grab('Show.S01.1080p', { coverage: seasons(3, 3), seasonId: 101 });
    assert.equal(await pending(1), false);
    assert.equal(await pending(3), true);
  });

  test('unparseable coverage is stored as unknown and falls back to the legacy checks', async (t) => {
    if (!reachable) return t.skip('fliks-migtest not reachable');
    await clear();
    await grab('Show.1080p', { coverage: { seasons: null, episodes: null, completeSeries: false }, seasonId: 101 });
    const row = (await repos.downloadHistory.findAll())[0]!;
    assert.equal(row.coverCompleteSeries, null);
    assert.equal(await pending(1), true);
  });

  test('healMatch fills coverage on a row that has none and leaves a known one alone', async (t) => {
    if (!reachable) return t.skip('fliks-migtest not reachable');
    await clear();
    await grab('Orphan.S01-S02.1080p');
    const id = (await repos.downloadHistory.findAll())[0]!.id;
    const heal = { mediaId, episodeId: null, seasonId: 101, quality: '1080p' };
    await repos.downloadHistory.healMatch(id, { ...heal, coverage: toCoverageColumns(seasons(1, 2)) });
    await repos.downloadHistory.healMatch(id, { ...heal, coverage: toCoverageColumns(seasons(7, 8)) });
    const row = (await repos.downloadHistory.findAll())[0]!;
    assert.deepEqual([row.coverSeasonFrom, row.coverSeasonTo, row.coverCompleteSeries], [1, 2, false]);
  });
});

describe('migration 0008', () => {
  test('adds nullable coverage columns, leaves existing rows null, and reverses cleanly', async (t) => {
    if (!reachable) return t.skip('fliks-migtest not reachable');
    const pluginId = 'test.download.coverage.mig';
    const schema = pluginSchemaName(pluginId);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const p = createPluginPool({ dsn: MIGTEST_DSN, pluginId });
    const columns = async () =>
      (await p.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'download_history' AND column_name LIKE 'cover%' ORDER BY column_name`,
        [schema],
      )).rows;
    try {
      const idx = MIGRATIONS.findIndex((m) => m.name === '0008_download_history_coverage');
      assert.ok(idx >= 0);
      await migrateUp(p);
      await migrateDown(p, MIGRATIONS.length - idx);
      assert.deepEqual(await columns(), []);
      await p.query(`INSERT INTO "download_history" ("sourceTitle", "quality", "grabSource") VALUES ('old', '1080p', 'auto')`);

      await migrateUp(p);
      assert.deepEqual(await columns(), [
        { column_name: 'coverCompleteSeries', data_type: 'boolean', is_nullable: 'YES' },
        { column_name: 'coverEpisodeFrom', data_type: 'integer', is_nullable: 'YES' },
        { column_name: 'coverEpisodeTo', data_type: 'integer', is_nullable: 'YES' },
        { column_name: 'coverSeasonFrom', data_type: 'integer', is_nullable: 'YES' },
        { column_name: 'coverSeasonTo', data_type: 'integer', is_nullable: 'YES' },
      ]);
      const { rows } = await p.query(`SELECT "coverCompleteSeries" AS c FROM "download_history"`);
      assert.deepEqual(rows, [{ c: null }]);
    } finally {
      await p.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });
});

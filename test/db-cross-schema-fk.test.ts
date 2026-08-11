/**
 * Proves the `REFERENCES`-only grant core provisions for a `coreRefs` table
 * (`backend/src/modules/plugins/plugin-database.service.ts`'s `GRANT REFERENCES (id) ON
 * public."<table>" TO "<identifier>"`, read-only reference from the Fliks repo) actually
 * behaves the way the plugin depends on: a plugin table's FK into `public.media` can be
 * created and enforced by a role holding only that grant, while a plain `SELECT` against
 * `public.media` by that same role is denied. Runs against `fliks-migtest` (55432) only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { Pool as PgPool } from 'pg';
import { isDatabaseReachable, adminPool, MIGTEST_DSN } from './db-test-helpers';

const ROLE = 'fk_proof_role_tmp';
const SCHEMA = 'fk_proof_schema_tmp';
const PASSWORD = 'fk_proof_password_tmp';

let reachable = false;
let admin: Pool;
let mediaId: number;

/** Idempotent teardown: `DROP OWNED BY` before `DROP ROLE` — a bare grant (like the
 *  `REFERENCES` one this test exists to prove) is itself a dependency that blocks
 *  `DROP ROLE` otherwise (mirrors `PluginDatabaseService.deprovision()`). Safe to call
 *  when nothing exists yet, so `before()` can use it as a pre-clean too. */
async function dropRoleAndSchema(): Promise<void> {
  const { rows } = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [ROLE]);
  if (rows.length > 0) await admin.query(`DROP OWNED BY "${ROLE}"`);
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.query(`DROP ROLE IF EXISTS "${ROLE}"`);
}

before(async () => {
  reachable = await isDatabaseReachable();
  if (!reachable) return;
  admin = adminPool();

  await dropRoleAndSchema();
  await admin.query(`CREATE ROLE "${ROLE}" LOGIN PASSWORD '${PASSWORD}'`);
  // Mirrors `PluginDatabaseService.provision()`: the role owns its own schema...
  await admin.query(`CREATE SCHEMA "${SCHEMA}" AUTHORIZATION "${ROLE}"`);
  // ...and gets REFERENCES-only on the core table's id column — never SELECT.
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${ROLE}"`);
  await admin.query(`GRANT REFERENCES ("id") ON public."media" TO "${ROLE}"`);

  const inserted = await admin.query<{ id: number }>(
    `INSERT INTO public."media" ("title", "type") VALUES ($1, 'movie') RETURNING id`,
    ['FK Proof Media'],
  );
  mediaId = inserted.rows[0]!.id;
});

after(async () => {
  if (!reachable) return;
  await admin.query(`DELETE FROM public."media" WHERE id = $1`, [mediaId]);
  await dropRoleAndSchema();
  await admin.end();
});

test('a role with only REFERENCES on public.media can create and use a table that FKs into it', async (t) => {
  if (!reachable) {
    t.skip('fliks-migtest not reachable on 127.0.0.1:55432');
    return;
  }

  const roleDsn = new URL(MIGTEST_DSN);
  roleDsn.username = ROLE;
  roleDsn.password = PASSWORD;
  roleDsn.searchParams.set('options', `-c search_path=${SCHEMA}`);
  const rolePool = new PgPool({ connectionString: roleDsn.toString() });

  try {
    // The FK itself can only be created because of the REFERENCES grant — this is the
    // plugin's own migration running as the plugin's own role, exactly as in production.
    await rolePool.query(
      `CREATE TABLE "download_history_fk_proof" (
         "id" SERIAL PRIMARY KEY,
         "mediaId" integer REFERENCES public."media"("id") ON DELETE CASCADE
       )`,
    );

    const validInsert = await rolePool.query(
      `INSERT INTO "download_history_fk_proof" ("mediaId") VALUES ($1) RETURNING id`,
      [mediaId],
    );
    assert.ok(validInsert.rows[0]?.id > 0, 'a valid core id must insert successfully');

    await assert.rejects(
      rolePool.query(`INSERT INTO "download_history_fk_proof" ("mediaId") VALUES ($1)`, [mediaId + 999_000]),
      (err: unknown) => (err as { code?: string }).code === '23503',
      'an invalid core id must be rejected by the FK constraint (23503)',
    );

    // The interesting half: REFERENCES is not SELECT. A plain read of the core table must be denied.
    await assert.rejects(
      rolePool.query(`SELECT * FROM public."media" WHERE id = $1`, [mediaId]),
      (err: unknown) => (err as { code?: string }).code === '42501',
      'SELECT on public.media must be denied (42501 insufficient_privilege) — REFERENCES is not SELECT',
    );

    // ON DELETE CASCADE actually cascades: deleting the core row removes the referencing row.
    await admin.query(`DELETE FROM public."media" WHERE id = $1`, [mediaId]);
    const remaining = await rolePool.query(`SELECT * FROM "download_history_fk_proof"`);
    assert.equal(remaining.rows.length, 0, 'ON DELETE CASCADE must have removed the referencing row');

    // Recreate for `after()`'s cleanup, which deletes by mediaId unconditionally.
    const recreated = await admin.query<{ id: number }>(
      `INSERT INTO public."media" ("title", "type") VALUES ($1, 'movie') RETURNING id`,
      ['FK Proof Media'],
    );
    mediaId = recreated.rows[0]!.id;
  } finally {
    await rolePool.end();
  }
});

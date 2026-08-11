import type { Pool, PoolClient } from 'pg';
import { MIGRATIONS } from '../../migrations';

export interface Migration {
  name: string;
  up: string;
  down: string;
}

/** Lives inside the plugin's own schema (via `search_path`, see `pool.ts`) — never a
 *  separate tracking database, never `public`. */
const TRACKING_TABLE = '_migrations';

async function ensureTrackingTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS "${TRACKING_TABLE}" (
       "name" text PRIMARY KEY,
       "appliedAt" timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function withTransaction(pool: Pool, run: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await run(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Applies every migration in `MIGRATIONS` not yet recorded, in file order, each in
 *  its own transaction. Called by the plugin at startup, before it accepts jobs/http. */
export async function migrateUp(pool: Pool): Promise<string[]> {
  await ensureTrackingTable(pool);
  const { rows } = await pool.query<{ name: string }>(`SELECT "name" FROM "${TRACKING_TABLE}"`);
  const applied = new Set(rows.map((r) => r.name));
  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    await withTransaction(pool, async (client) => {
      await client.query(migration.up);
      await client.query(`INSERT INTO "${TRACKING_TABLE}" ("name") VALUES ($1)`, [migration.name]);
    });
    ran.push(migration.name);
  }
  return ran;
}

/** Reverts the last `steps` applied migrations, newest first, each in its own transaction. */
export async function migrateDown(pool: Pool, steps = 1): Promise<string[]> {
  await ensureTrackingTable(pool);
  const { rows } = await pool.query<{ name: string }>(
    `SELECT "name" FROM "${TRACKING_TABLE}" ORDER BY "appliedAt" DESC, "name" DESC LIMIT $1`,
    [steps],
  );
  const byName = new Map(MIGRATIONS.map((m) => [m.name, m]));
  const reverted: string[] = [];
  for (const { name } of rows) {
    const migration = byName.get(name);
    if (!migration) throw new Error(`migration "${name}" is recorded as applied but no longer exists`);
    await withTransaction(pool, async (client) => {
      await client.query(migration.down);
      await client.query(`DELETE FROM "${TRACKING_TABLE}" WHERE "name" = $1`, [name]);
    });
    reverted.push(name);
  }
  return reverted;
}

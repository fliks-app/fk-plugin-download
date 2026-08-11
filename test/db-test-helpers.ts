/** Shared plumbing for the `db*.test.ts` files — not itself a test (no `.test.ts` suffix,
 *  so `npm test`'s `test/*.test.ts` glob skips it). Targets `fliks-migtest` on port 55432
 *  only; never the Fliks dev database on 5434. */
import { Pool } from 'pg';

export const MIGTEST_DSN = process.env.FK_TEST_PG_DSN ?? 'postgresql://fliks:fliks@127.0.0.1:55432/fliks';

export async function isDatabaseReachable(): Promise<boolean> {
  const pool = new Pool({ connectionString: MIGTEST_DSN, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

export function adminPool(): Pool {
  return new Pool({ connectionString: MIGTEST_DSN });
}

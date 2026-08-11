import type { Pool } from 'pg';
import type { IsoTimestamp, StalledCheckRow } from '../rows';

const COLUMNS = `"id", "torrentHash", "downloadedBytes", "checkedAt"`;

/** Fliks repo call site: `completion.service.ts` (stalled-download cleanup) and
 *  `download-clients/download-clients.service.ts` (`annotateStalledStrikes`). */
export class StalledChecksRepository {
  constructor(private readonly pool: Pool) {}

  /** `completion.service.ts:1080` — one byte-count snapshot per check tick.
   *  `downloadedBytes` is a JS `number`; see `pool.ts` for the OID 20 (`bigint`) type parser
   *  that makes the round trip lossless above 2^31. */
  async insert(torrentHash: string, downloadedBytes: number): Promise<StalledCheckRow> {
    const { rows } = await this.pool.query<StalledCheckRow>(
      `INSERT INTO "stalled_checks" ("torrentHash", "downloadedBytes") VALUES ($1, $2) RETURNING ${COLUMNS}`,
      [torrentHash, downloadedBytes],
    );
    const row = rows[0];
    if (!row) throw new Error('insert into "stalled_checks" returned no row');
    return row;
  }

  /** `completion.service.ts:1070` — latest snapshot, to gate on the configured check interval. */
  async findLatest(torrentHash: string): Promise<StalledCheckRow | null> {
    const { rows } = await this.pool.query<StalledCheckRow>(
      `SELECT ${COLUMNS} FROM "stalled_checks" WHERE "torrentHash" = $1 ORDER BY "checkedAt" DESC LIMIT 1`,
      [torrentHash],
    );
    return rows[0] ?? null;
  }

  /** `completion.service.ts:1088` — last N snapshots for one hash, newest first, feeds the stall-strike count. */
  async findRecent(torrentHash: string, limit: number): Promise<StalledCheckRow[]> {
    const { rows } = await this.pool.query<StalledCheckRow>(
      `SELECT ${COLUMNS} FROM "stalled_checks" WHERE "torrentHash" = $1 ORDER BY "checkedAt" DESC LIMIT $2`,
      [torrentHash, limit],
    );
    return rows;
  }

  /** `download-clients.service.ts:509` (`annotateStalledStrikes`) — bulk fetch across many hashes at once. */
  async findRecentForHashes(hashes: string[]): Promise<StalledCheckRow[]> {
    const { rows } = await this.pool.query<StalledCheckRow>(
      `SELECT ${COLUMNS} FROM "stalled_checks" WHERE "torrentHash" = ANY($1::text[]) ORDER BY "checkedAt" DESC`,
      [hashes],
    );
    return rows;
  }

  /** `completion.service.ts:1012` — right after the torrent is removed from the client + blocklisted. */
  async deleteByHash(torrentHash: string): Promise<void> {
    await this.pool.query(`DELETE FROM "stalled_checks" WHERE "torrentHash" = $1`, [torrentHash]);
  }

  /** `completion.service.ts:1109` (`pruneOldStalledChecks`) — deletes rows older than the cutoff,
   *  returns how many. */
  async pruneOlderThan(cutoff: IsoTimestamp): Promise<number> {
    const result = await this.pool.query(`DELETE FROM "stalled_checks" WHERE "checkedAt" < $1`, [cutoff]);
    return result.rowCount ?? 0;
  }
}

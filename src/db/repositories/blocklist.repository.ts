import type { Pool } from 'pg';
import type { BlocklistRow } from '../rows';

const COLUMNS = `"id", "sourceTitle", "indexerName", "downloadUrl", "quality", "note",
  "indexerId", "mediaId", "userId", "createdAt", "updatedAt"`;

export interface NewBlocklistEntry {
  sourceTitle: string;
  indexerId?: number | null;
  indexerName?: string | null;
  downloadUrl?: string | null;
  quality?: string | null;
  mediaId?: number | null;
  note?: string | null;
  userId?: number | null;
}

/** Fliks repo call site: `blocklist/blocklist.service.ts`, plus `createFromHistory`
 *  callers in `completion.service.ts` and `download-clients.service.ts`. */
export class BlocklistRepository {
  constructor(private readonly pool: Pool) {}

  /** `blocklist.service.ts:20-35` (`create`) and `:40-51` (`createFromHistory`) — same INSERT shape. */
  async insert(input: NewBlocklistEntry): Promise<BlocklistRow> {
    const { rows } = await this.pool.query<BlocklistRow>(
      `INSERT INTO "blocklist"
         ("sourceTitle", "indexerId", "indexerName", "downloadUrl", "quality", "mediaId", "note", "userId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLUMNS}`,
      [
        input.sourceTitle,
        input.indexerId ?? null,
        input.indexerName ?? null,
        input.downloadUrl ?? null,
        input.quality ?? null,
        input.mediaId ?? null,
        input.note ?? null,
        input.userId ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('insert into "blocklist" returned no row');
    return row;
  }

  /** `blocklist.service.ts:57` (`findAll`) — paginated admin list, newest first. */
  async list(limit: number, offset: number): Promise<{ items: BlocklistRow[]; total: number }> {
    const [itemsResult, countResult] = await Promise.all([
      this.pool.query<BlocklistRow>(
        `SELECT ${COLUMNS} FROM "blocklist" ORDER BY "createdAt" DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      this.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS "count" FROM "blocklist"`),
    ]);
    return { items: itemsResult.rows, total: Number(countResult.rows[0]?.count ?? 0) };
  }

  /** `blocklist.service.ts:65-70` (`isBlocked`) — case-insensitive exact match, not a substring search. */
  async isBlocked(sourceTitle: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS "count" FROM "blocklist" WHERE LOWER("sourceTitle") = LOWER($1)`,
      [sourceTitle],
    );
    return Number(rows[0]?.count ?? 0) > 0;
  }

  /** `blocklist.service.ts:73` — looked up before `remove` to 404 on a missing id. */
  async findById(id: number): Promise<BlocklistRow | null> {
    const { rows } = await this.pool.query<BlocklistRow>(`SELECT ${COLUMNS} FROM "blocklist" WHERE "id" = $1`, [id]);
    return rows[0] ?? null;
  }

  /** `blocklist.service.ts:73-76`. */
  async remove(id: number): Promise<void> {
    await this.pool.query(`DELETE FROM "blocklist" WHERE "id" = $1`, [id]);
  }

  /** `blocklist.service.ts:79-81` (`clear`) — admin "clear all". */
  async clear(): Promise<void> {
    await this.pool.query(`DELETE FROM "blocklist"`);
  }
}

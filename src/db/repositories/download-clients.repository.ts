import type { Pool } from 'pg';
import type { DownloadClientRow } from '../rows';

const COLUMNS = `"id", "name", "implementation", "settings", "enabled", "priority", "createdAt", "updatedAt"`;

export interface NewDownloadClient {
  name: string;
  implementation: string;
  settings: Record<string, unknown>;
  enabled: boolean;
  priority: number;
}

export interface DownloadClientUpdate extends NewDownloadClient {}

/** Fliks repo call sites: `download-clients/download-clients.service.ts`,
 *  `acquisition-scheduler.service.ts`, `completion.service.ts`, `episode-download.service.ts`,
 *  `movie-download.service.ts`, `download-bundle.module.ts`. */
export class DownloadClientsRepository {
  constructor(private readonly pool: Pool) {}

  /** `acquisition-scheduler.service.ts:182,482`, `completion.service.ts:295,950,1120`,
   *  `download-clients.service.ts:251,281,334,379`. */
  async listEnabled(): Promise<DownloadClientRow[]> {
    const { rows } = await this.pool.query<DownloadClientRow>(
      `SELECT ${COLUMNS} FROM "download_clients" WHERE "enabled" = true ORDER BY "priority" ASC, "id" ASC`,
    );
    return rows;
  }

  /** `episode-download.service.ts:340,620`, `movie-download.service.ts:313,552`,
   *  `download-clients.service.ts:150` (admin list, no `enabled` filter). */
  async listAll(): Promise<DownloadClientRow[]> {
    const { rows } = await this.pool.query<DownloadClientRow>(
      `SELECT ${COLUMNS} FROM "download_clients" ORDER BY "priority" ASC, "id" ASC`,
    );
    return rows;
  }

  /** `download-bundle.module.ts:146` — setup-checklist gate. */
  async countEnabled(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS "count" FROM "download_clients" WHERE "enabled" = true`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** `download-clients.service.ts:155`. */
  async findById(id: number): Promise<DownloadClientRow | null> {
    const { rows } = await this.pool.query<DownloadClientRow>(
      `SELECT ${COLUMNS} FROM "download_clients" WHERE "id" = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** `download-clients.service.ts:138-145`. */
  async insert(input: NewDownloadClient): Promise<DownloadClientRow> {
    const { rows } = await this.pool.query<DownloadClientRow>(
      `INSERT INTO "download_clients" ("name", "implementation", "settings", "enabled", "priority")
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [input.name, input.implementation, input.settings, input.enabled, input.priority],
    );
    const row = rows[0];
    if (!row) throw new Error('insert into "download_clients" returned no row');
    return row;
  }

  /** `download-clients.service.ts:173`. */
  async update(id: number, input: DownloadClientUpdate): Promise<DownloadClientRow> {
    const { rows } = await this.pool.query<DownloadClientRow>(
      `UPDATE "download_clients" SET
         "name" = $2, "implementation" = $3, "settings" = $4, "enabled" = $5, "priority" = $6, "updatedAt" = now()
       WHERE "id" = $1
       RETURNING ${COLUMNS}`,
      [id, input.name, input.implementation, input.settings, input.enabled, input.priority],
    );
    const row = rows[0];
    if (!row) throw new Error(`"download_clients" row ${id} not found`);
    return row;
  }

  /** `download-clients.service.ts:179`. */
  async remove(id: number): Promise<void> {
    await this.pool.query(`DELETE FROM "download_clients" WHERE "id" = $1`, [id]);
  }
}

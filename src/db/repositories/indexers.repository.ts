import type { Pool } from 'pg';
import type { IndexerRow } from '../rows';

const COLUMNS = `"id", "name", "implementation", "settings", "enableRss", "enableSearch",
  "priority", "enabled", "capsSearchFallback", "capsMovieSearch", "capsTvSearch", "capsProbedAt",
  "requestDelay", "createdAt", "updatedAt"`;

export interface NewIndexer {
  name: string;
  implementation: string;
  settings: Record<string, unknown>;
  enableRss: boolean;
  enableSearch: boolean;
  priority: number;
  requestDelay: number;
  enabled: boolean;
}

export interface IndexerUpdate extends NewIndexer {}

/**
 * Fliks repo call sites (`backend/src/plugins/download/`), read-only reference:
 * `indexers/indexers.service.ts`, `indexers/torznab.service.ts`,
 * `acquisition-scheduler.service.ts`, `episode-download.service.ts`,
 * `movie-download.service.ts`, `download-bundle.module.ts`, `blocklist/blocklist.service.ts`.
 */
export class IndexersRepository {
  constructor(private readonly pool: Pool) {}

  /** Enabled indexers by priority — the search fan-out order.
   *  `acquisition-scheduler.service.ts:178,447`, `episode-download.service.ts:157,495,682`,
   *  `movie-download.service.ts:183,405`. */
  async listEnabled(): Promise<IndexerRow[]> {
    const { rows } = await this.pool.query<IndexerRow>(
      `SELECT ${COLUMNS} FROM "indexers" WHERE "enabled" = true ORDER BY "priority" ASC, "id" ASC`,
    );
    return rows;
  }

  /** Enabled + RSS-enabled indexers by priority — `acquisition-scheduler.service.ts:447` (RssSync). */
  async listEnabledForRss(): Promise<IndexerRow[]> {
    const { rows } = await this.pool.query<IndexerRow>(
      `SELECT ${COLUMNS} FROM "indexers" WHERE "enabled" = true AND "enableRss" = true ORDER BY "priority" ASC, "id" ASC`,
    );
    return rows;
  }

  /** Every indexer, enabled or not — `indexers.service.ts:103` (admin list),
   *  `completion.service.ts:1154` (settings lookup for cleanSeededTorrents). */
  async listAll(): Promise<IndexerRow[]> {
    const { rows } = await this.pool.query<IndexerRow>(
      `SELECT ${COLUMNS} FROM "indexers" ORDER BY "priority" ASC, "id" ASC`,
    );
    return rows;
  }

  /** `download-bundle.module.ts:139` — setup-checklist gate. */
  async countEnabled(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS "count" FROM "indexers" WHERE "enabled" = true`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** `indexers.service.ts:134`, `blocklist/blocklist.service.ts:24`. */
  async findById(id: number): Promise<IndexerRow | null> {
    const { rows } = await this.pool.query<IndexerRow>(`SELECT ${COLUMNS} FROM "indexers" WHERE "id" = $1`, [id]);
    return rows[0] ?? null;
  }

  /** The identity an import dedupes on: the torznab endpoint is derived from the source and the
   *  remote indexer's own id, so it names one remote tracker even after a local rename. */
  async findByBaseUrl(baseUrl: string): Promise<IndexerRow | null> {
    const { rows } = await this.pool.query<IndexerRow>(
      `SELECT ${COLUMNS} FROM "indexers" WHERE "settings"->>'baseUrl' = $1 ORDER BY "id" ASC LIMIT 1`,
      [baseUrl],
    );
    return rows[0] ?? null;
  }

  /** `indexers.service.ts:82-93`. */
  async insert(input: NewIndexer): Promise<IndexerRow> {
    const { rows } = await this.pool.query<IndexerRow>(
      `INSERT INTO "indexers"
         ("name", "implementation", "settings", "enableRss", "enableSearch", "priority", "requestDelay", "enabled")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLUMNS}`,
      [
        input.name,
        input.implementation,
        input.settings,
        input.enableRss,
        input.enableSearch,
        input.priority,
        input.requestDelay,
        input.enabled,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('insert into "indexers" returned no row');
    return row;
  }

  /** `indexers.service.ts:161` — full-entity save. */
  async update(id: number, input: IndexerUpdate): Promise<IndexerRow> {
    const { rows } = await this.pool.query<IndexerRow>(
      `UPDATE "indexers" SET
         "name" = $2, "implementation" = $3, "enableRss" = $4, "enableSearch" = $5,
         "priority" = $6, "requestDelay" = $7, "enabled" = $8, "settings" = $9, "updatedAt" = now()
       WHERE "id" = $1
       RETURNING ${COLUMNS}`,
      [
        id,
        input.name,
        input.implementation,
        input.enableRss,
        input.enableSearch,
        input.priority,
        input.requestDelay,
        input.enabled,
        input.settings,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error(`"indexers" row ${id} not found`);
    return row;
  }

  /** Settings-only write, for an import refreshing a rotated API key on a row whose name,
   *  priority and tuning are the admin's. */
  async updateSettings(id: number, settings: Record<string, unknown>): Promise<void> {
    await this.pool.query(`UPDATE "indexers" SET "settings" = $2, "updatedAt" = now() WHERE "id" = $1`, [
      id,
      settings,
    ]);
  }

  /** `indexers/torznab.service.ts:256` — caps refresh after a `t=caps` probe. */
  async refreshCaps(
    id: number,
    caps: { capsMovieSearch: boolean; capsTvSearch: boolean; capsSearchFallback: boolean },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE "indexers" SET "capsMovieSearch" = $2, "capsTvSearch" = $3, "capsSearchFallback" = $4,
              "capsProbedAt" = NOW() WHERE "id" = $1`,
      [id, caps.capsMovieSearch, caps.capsTvSearch, caps.capsSearchFallback],
    );
  }

  /** `indexers/torznab.service.ts:386` — a typed search failed, the untyped retry succeeded. */
  async markSearchFallback(id: number): Promise<void> {
    await this.pool.query(`UPDATE "indexers" SET "capsSearchFallback" = true WHERE "id" = $1`, [id]);
  }

  /** `indexers.service.ts:168`. */
  async remove(id: number): Promise<void> {
    await this.pool.query(`DELETE FROM "indexers" WHERE "id" = $1`, [id]);
  }
}

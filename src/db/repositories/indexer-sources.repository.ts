import type { Pool } from 'pg';
import type { IndexerSourceRow } from '../rows';

const COLUMNS = `"id", "name", "implementation", "settings", "priority", "enabled", "createdAt", "updatedAt"`;

export interface NewIndexerSource {
  name: string;
  implementation: string;
  settings: Record<string, unknown>;
  priority: number;
  enabled: boolean;
}

export interface IndexerSourceUpdate extends NewIndexerSource {}

export class IndexerSourcesRepository {
  constructor(private readonly pool: Pool) {}

  async listAll(): Promise<IndexerSourceRow[]> {
    const { rows } = await this.pool.query<IndexerSourceRow>(
      `SELECT ${COLUMNS} FROM "indexer_sources" ORDER BY "priority" ASC, "id" ASC`,
    );
    return rows;
  }

  async findById(id: number): Promise<IndexerSourceRow | null> {
    const { rows } = await this.pool.query<IndexerSourceRow>(
      `SELECT ${COLUMNS} FROM "indexer_sources" WHERE "id" = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async insert(input: NewIndexerSource): Promise<IndexerSourceRow> {
    const { rows } = await this.pool.query<IndexerSourceRow>(
      `INSERT INTO "indexer_sources" ("name", "implementation", "settings", "priority", "enabled")
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [input.name, input.implementation, input.settings, input.priority, input.enabled],
    );
    const row = rows[0];
    if (!row) throw new Error('insert into "indexer_sources" returned no row');
    return row;
  }

  async update(id: number, input: IndexerSourceUpdate): Promise<IndexerSourceRow> {
    const { rows } = await this.pool.query<IndexerSourceRow>(
      `UPDATE "indexer_sources" SET
         "name" = $2, "implementation" = $3, "settings" = $4, "priority" = $5, "enabled" = $6,
         "updatedAt" = now()
       WHERE "id" = $1
       RETURNING ${COLUMNS}`,
      [id, input.name, input.implementation, input.settings, input.priority, input.enabled],
    );
    const row = rows[0];
    if (!row) throw new Error(`"indexer_sources" row ${id} not found`);
    return row;
  }

  async remove(id: number): Promise<void> {
    await this.pool.query(`DELETE FROM "indexer_sources" WHERE "id" = $1`, [id]);
  }
}

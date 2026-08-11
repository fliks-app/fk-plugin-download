import type { Pool } from 'pg';
import type { IndexerStatRow, IsoTimestamp } from '../rows';

const COLUMNS = `"id", "indexerId", "queryDate", "queryType", "responseTimeMs", "resultCount", "errorMessage"`;

export interface NewIndexerStat {
  indexerId: number | null;
  queryType: string;
  responseTimeMs: number;
  resultCount: number;
  errorMessage: string | null;
}

export interface IndexerDailyStat {
  date: string;
  queries: number;
  avgResponseMs: number;
  totalResults: number;
  errors: number;
}

/** Fliks repo call sites: `indexers/torznab.service.ts` (search/RSS success, error,
 *  transport-failure — 5 insert sites) and `indexers/indexers.controller.ts` (per-indexer stats). */
export class IndexerStatsRepository {
  constructor(private readonly pool: Pool) {}

  /** `torznab.service.ts:326,339,356,453,466`. */
  async insert(input: NewIndexerStat): Promise<IndexerStatRow> {
    const { rows } = await this.pool.query<IndexerStatRow>(
      `INSERT INTO "indexer_stats" ("indexerId", "queryType", "responseTimeMs", "resultCount", "errorMessage")
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [input.indexerId, input.queryType, input.responseTimeMs, input.resultCount, input.errorMessage],
    );
    const row = rows[0];
    if (!row) throw new Error('insert into "indexer_stats" returned no row');
    return row;
  }

  /** `indexers.controller.ts:88-102` — daily query count/latency/results/errors since a cutoff. */
  async dailyStats(indexerId: number, since: IsoTimestamp): Promise<IndexerDailyStat[]> {
    const { rows } = await this.pool.query<IndexerDailyStat>(
      `SELECT DATE("queryDate")::text AS "date",
              COUNT(*)::int AS "queries",
              AVG("responseTimeMs")::int AS "avgResponseMs",
              SUM("resultCount")::int AS "totalResults",
              SUM(CASE WHEN "errorMessage" IS NOT NULL THEN 1 ELSE 0 END)::int AS "errors"
         FROM "indexer_stats"
        WHERE "indexerId" = $1 AND "queryDate" >= $2
        GROUP BY DATE("queryDate")
        ORDER BY "date" DESC`,
      [indexerId, since],
    );
    return rows;
  }
}

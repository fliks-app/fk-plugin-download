import type { Pool } from 'pg';
import type { DownloadHistoryRow, DownloadHistoryStatus, GrabSource, IsoTimestamp } from '../rows';

const COLUMNS = `"id", "sourceTitle", "quality", "language", "torrentHash", "status", "statusMessage",
  "grabSource", "mediaId", "episodeId", "seasonId", "indexerId", "downloadClientId", "createdAt", "updatedAt"`;

export interface NewDownloadHistoryGrab {
  sourceTitle: string;
  quality: string;
  language?: string | null;
  torrentHash?: string | null;
  grabSource: GrabSource;
  mediaId: number;
  episodeId?: number | null;
  seasonId?: number | null;
  indexerId?: number | null;
  downloadClientId?: number | null;
}

export interface HealMatchPatch {
  mediaId: number;
  episodeId: number | null;
  seasonId: number | null;
  quality: string;
}

/**
 * Fliks repo call sites (`backend/src/plugins/download/`): `acquisition-events.service.ts`,
 * `acquisition-scheduler.service.ts`, `completion.service.ts`, `auto-grab-pipeline.service.ts`,
 * `movie-download.service.ts`, `episode-download.service.ts`, `torrent-history-matcher.service.ts`,
 * `download-clients/download-clients.service.ts`. `mediaId`/`episodeId`/`seasonId`/`indexerId` are
 * never joined here — every read returns bare ids, resolved through a host method by the caller.
 */
export class DownloadHistoryRepository {
  constructor(private readonly pool: Pool) {}

  /** `acquisition-events.service.ts:76` — the queue-active sidebar badge. */
  async countActive(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS "count" FROM "download_history" WHERE "status" IN ('grabbed', 'importing')`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** `acquisition-scheduler.service.ts:257,544` — "is a grab already pending for this media". */
  async findPendingGrabForMedia(mediaId: number): Promise<DownloadHistoryRow | null> {
    const { rows } = await this.pool.query<DownloadHistoryRow>(
      `SELECT ${COLUMNS} FROM "download_history" WHERE "mediaId" = $1 AND "status" = 'grabbed' LIMIT 1`,
      [mediaId],
    );
    return rows[0] ?? null;
  }

  /** `acquisition-scheduler.service.ts:344,636,625` — dedup by episode-tag substring in
   *  `sourceTitle` (caller builds the ILIKE pattern, e.g. `%S01E03%`). */
  async findPendingEpisodeGrab(mediaId: number, sourceTitlePattern: string): Promise<DownloadHistoryRow | null> {
    const { rows } = await this.pool.query<DownloadHistoryRow>(
      `SELECT ${COLUMNS} FROM "download_history"
        WHERE "mediaId" = $1 AND "status" = 'grabbed' AND "sourceTitle" ILIKE $2
        LIMIT 1`,
      [mediaId, sourceTitlePattern],
    );
    return rows[0] ?? null;
  }

  /** `acquisition-scheduler.service.ts:394` — "is a season-pack grab already pending for this season". */
  async findPendingSeasonPackGrab(mediaId: number, seasonId: number): Promise<DownloadHistoryRow | null> {
    const { rows } = await this.pool.query<DownloadHistoryRow>(
      `SELECT ${COLUMNS} FROM "download_history"
        WHERE "mediaId" = $1 AND "status" = 'grabbed' AND "seasonId" = $2 AND "episodeId" IS NULL
        LIMIT 1`,
      [mediaId, seasonId],
    );
    return rows[0] ?? null;
  }

  /** `acquisition-scheduler.service.ts:737` — RSS dedup, exact title match, any status. */
  async findBySourceTitleForMedia(mediaId: number, sourceTitle: string): Promise<DownloadHistoryRow | null> {
    const { rows } = await this.pool.query<DownloadHistoryRow>(
      `SELECT ${COLUMNS} FROM "download_history" WHERE "mediaId" = $1 AND "sourceTitle" = $2 LIMIT 1`,
      [mediaId, sourceTitle],
    );
    return rows[0] ?? null;
  }

  /** `acquisition-scheduler.service.ts:761` — recent grabbed rows for a media, to detect a
   *  recent season-pack grab client-side. */
  async findRecentGrabbedForMedia(mediaId: number, since: IsoTimestamp): Promise<DownloadHistoryRow[]> {
    const { rows } = await this.pool.query<DownloadHistoryRow>(
      `SELECT ${COLUMNS} FROM "download_history" WHERE "mediaId" = $1 AND "status" = 'grabbed' AND "createdAt" >= $2`,
      [mediaId, since],
    );
    return rows;
  }

  /** `completion.service.ts:165` — unfiltered, for orphan-torrent auto-matching. */
  async findAll(): Promise<DownloadHistoryRow[]> {
    const { rows } = await this.pool.query<DownloadHistoryRow>(`SELECT ${COLUMNS} FROM "download_history"`);
    return rows;
  }

  /** `completion.service.ts:330,340,444,959`, `download-clients.service.ts:398` — every
   *  "rows in status X or Y or Z" read collapses to one status-list filter. */
  async findByStatuses(statuses: DownloadHistoryStatus[]): Promise<DownloadHistoryRow[]> {
    const { rows } = await this.pool.query<DownloadHistoryRow>(
      `SELECT ${COLUMNS} FROM "download_history" WHERE "status" = ANY($1::text[])`,
      [statuses],
    );
    return rows;
  }

  /** `completion.service.ts:1145` — completed rows whose hash is among the ones a client currently holds. */
  async findCompletedByHashes(hashes: string[]): Promise<DownloadHistoryRow[]> {
    const { rows } = await this.pool.query<DownloadHistoryRow>(
      `SELECT ${COLUMNS} FROM "download_history"
        WHERE "status" = 'completed' AND LOWER("torrentHash") = ANY($1::text[])`,
      [hashes.map((h) => h.toLowerCase())],
    );
    return rows;
  }

  /** `download-clients.service.ts:245,327` — latest row for an exact hash. */
  async findLatestByTorrentHash(torrentHash: string): Promise<DownloadHistoryRow | null> {
    const { rows } = await this.pool.query<DownloadHistoryRow>(
      `SELECT ${COLUMNS} FROM "download_history" WHERE "torrentHash" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [torrentHash],
    );
    return rows[0] ?? null;
  }

  /** `download-clients.service.ts:260,343` — latest row for an exact source title, hash-lookup fallback. */
  async findLatestBySourceTitle(sourceTitle: string): Promise<DownloadHistoryRow | null> {
    const { rows } = await this.pool.query<DownloadHistoryRow>(
      `SELECT ${COLUMNS} FROM "download_history" WHERE "sourceTitle" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [sourceTitle],
    );
    return rows[0] ?? null;
  }

  /** `auto-grab-pipeline.service.ts:268`, `completion.service.ts:249`, `movie-download.service.ts:331,574`,
   *  `episode-download.service.ts:358,651,756,874`, `download-clients.service.ts:297` — every grab/link
   *  INSERT funnels through the same column set (`grab-history.util.ts`'s `buildGrabHistoryRow` shape). */
  async insertGrab(input: NewDownloadHistoryGrab): Promise<DownloadHistoryRow> {
    const { rows } = await this.pool.query<DownloadHistoryRow>(
      `INSERT INTO "download_history"
         ("sourceTitle", "quality", "language", "torrentHash", "grabSource",
          "mediaId", "episodeId", "seasonId", "indexerId", "downloadClientId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${COLUMNS}`,
      [
        input.sourceTitle,
        input.quality,
        input.language ?? null,
        input.torrentHash ?? null,
        input.grabSource,
        input.mediaId,
        input.episodeId ?? null,
        input.seasonId ?? null,
        input.indexerId ?? null,
        input.downloadClientId ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('insert into "download_history" returned no row');
    return row;
  }

  /** `completion.service.ts:389` — mark import started; leaves `statusMessage` untouched. */
  async markImporting(id: number): Promise<void> {
    await this.pool.query(`UPDATE "download_history" SET "status" = 'importing', "updatedAt" = now() WHERE "id" = $1`, [
      id,
    ]);
  }

  /** `completion.service.ts:402,607,655,675,743`, `download-clients.service.ts:223`. */
  async markFailed(id: number, statusMessage: string): Promise<void> {
    await this.pool.query(
      `UPDATE "download_history" SET "status" = 'failed', "statusMessage" = $2, "updatedAt" = now() WHERE "id" = $1`,
      [id, statusMessage],
    );
  }

  /** `completion.service.ts:517,534,552` — bulk re-arm/flip by id array. */
  async updateStatusByIds(ids: number[], status: DownloadHistoryStatus, statusMessage: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE "download_history" SET "status" = $2, "statusMessage" = $3, "updatedAt" = now() WHERE "id" = ANY($1::int[])`,
      [ids, status, statusMessage],
    );
  }

  /** `completion.service.ts:113` — boot re-arm of every stranded `importing` row. */
  async resetStatus(fromStatus: DownloadHistoryStatus, toStatus: DownloadHistoryStatus): Promise<void> {
    await this.pool.query(`UPDATE "download_history" SET "status" = $2 WHERE "status" = $1`, [fromStatus, toStatus]);
  }

  /** `completion.service.ts:786` — 3 variants (bare, episode+season, season-only) collapse to one
   *  optional patch: omit it for a plain movie import, pass it (with `episodeId: null` for a season
   *  pack) once the imported files resolve to a season/episode. */
  async completeImport(id: number, patch?: { episodeId: number | null; seasonId: number | null }): Promise<void> {
    if (!patch) {
      await this.pool.query(
        `UPDATE "download_history" SET "status" = 'completed', "updatedAt" = now() WHERE "id" = $1`,
        [id],
      );
      return;
    }
    await this.pool.query(
      `UPDATE "download_history"
         SET "status" = 'completed', "episodeId" = $2, "seasonId" = $3, "updatedAt" = now()
       WHERE "id" = $1`,
      [id, patch.episodeId, patch.seasonId],
    );
  }

  /** `download-clients.service.ts:364` — re-arm + optionally heal the torrent hash. */
  async reimport(id: number, torrentHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE "download_history"
         SET "torrentHash" = $2, "status" = 'grabbed', "statusMessage" = NULL, "updatedAt" = now()
       WHERE "id" = $1`,
      [id, torrentHash],
    );
  }

  /** `torrent-history-matcher.service.ts:138` (`healHash`) — self-heal a name-matched row's hash. */
  async updateTorrentHash(id: number, torrentHash: string): Promise<void> {
    await this.pool.query(`UPDATE "download_history" SET "torrentHash" = $2, "updatedAt" = now() WHERE "id" = $1`, [
      id,
      torrentHash,
    ]);
  }

  /** `completion.service.ts:246` — heal an orphan row once its real media/episode/season/quality is known. */
  async healMatch(id: number, patch: HealMatchPatch): Promise<void> {
    await this.pool.query(
      `UPDATE "download_history"
         SET "mediaId" = $2, "episodeId" = $3, "seasonId" = $4, "quality" = $5, "updatedAt" = now()
       WHERE "id" = $1`,
      [id, patch.mediaId, patch.episodeId, patch.seasonId, patch.quality],
    );
  }
}

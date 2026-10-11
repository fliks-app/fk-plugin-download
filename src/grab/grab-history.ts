import { decodeHtmlEntities } from '../indexers/decode-html-entities';
import type { NewDownloadHistoryGrab } from '../db/repositories';
import type { DownloadHistoryCoverage, GrabSource } from '../db/rows';
import type { ReleaseCoverage } from '../host-methods';

/**
 * Ported from `backend/src/plugins/download/grab-history.util.ts`'s
 * `buildGrabHistoryRow`. Single source of truth for the field set every grab
 * path writes, so a missing field can't drift between the movie / episode /
 * season-pack / RSS / orphan-heal call sites.
 *
 * Upstream built a TypeORM `DeepPartial<DownloadHistory>` with relation casts;
 * this plugin has no ORM, so the equivalent is the repository's plain
 * `NewDownloadHistoryGrab` insert shape.
 */
/** Unparseable coverage (no season, not a complete series) is stored as unknown, so dedup keeps
 *  judging that row on its seasonId / title rather than treating it as covering nothing. */
export function toCoverageColumns(coverage: ReleaseCoverage | null | undefined): DownloadHistoryCoverage {
  if (!coverage || (!coverage.completeSeries && !coverage.seasons)) {
    return { coverSeasonFrom: null, coverSeasonTo: null, coverEpisodeFrom: null, coverEpisodeTo: null, coverCompleteSeries: null };
  }
  return {
    coverSeasonFrom: coverage.seasons?.from ?? null,
    coverSeasonTo: coverage.seasons?.to ?? null,
    coverEpisodeFrom: coverage.episodes?.from ?? null,
    coverEpisodeTo: coverage.episodes?.to ?? null,
    coverCompleteSeries: coverage.completeSeries,
  };
}

export function buildGrabHistoryRow(args: {
  mediaId: number;
  downloadClientId: number;
  sourceTitle: string;
  torrentHash: string | null | undefined;
  size?: number | null;
  infoUrl?: string | null;
  quality: string;
  grabSource: GrabSource;
  indexerId?: number | null;
  episodeId?: number | null;
  seasonId?: number | null;
  coverage?: ReleaseCoverage | null;
}): NewDownloadHistoryGrab {
  return {
    mediaId: args.mediaId,
    downloadClientId: args.downloadClientId,
    // Decode HTML entities ahead of persistence so the stored title matches
    // what the client renders (it decodes on display) — otherwise the
    // matcher's name-fallback comparison drifts and the orphan sweep
    // eventually flips the row to failed.
    sourceTitle: decodeHtmlEntities(args.sourceTitle),
    torrentHash: args.torrentHash || null,
    size: args.size || null,
    infoUrl: args.infoUrl || null,
    quality: args.quality,
    grabSource: args.grabSource,
    indexerId: args.indexerId ?? null,
    episodeId: args.episodeId ?? null,
    seasonId: args.seasonId ?? null,
    coverage: toCoverageColumns(args.coverage),
  };
}

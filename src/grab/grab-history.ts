import { decodeHtmlEntities } from '../indexers/decode-html-entities';
import type { NewDownloadHistoryGrab } from '../db/repositories';
import type { GrabSource } from '../db/rows';

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
export function buildGrabHistoryRow(args: {
  mediaId: number;
  downloadClientId: number;
  sourceTitle: string;
  torrentHash: string | null | undefined;
  size?: number | null;
  quality: string;
  grabSource: GrabSource;
  indexerId?: number | null;
  episodeId?: number | null;
  seasonId?: number | null;
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
    quality: args.quality,
    grabSource: args.grabSource,
    indexerId: args.indexerId ?? null,
    episodeId: args.episodeId ?? null,
    seasonId: args.seasonId ?? null,
  };
}

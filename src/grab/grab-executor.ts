import type { DownloadClientDriver } from '../download-clients/contract';
import type { DownloadClientRow, GrabSource } from '../db/rows';
import type { DownloadHistoryRepository } from '../db/repositories';
import { buildGrabHistoryRow } from './grab-history';
import type { HostCaller } from './types';
import { log } from '../log';

export interface GrabExecutorDeps {
  host: HostCaller;
  driver: DownloadClientDriver;
  historyRepo: Pick<DownloadHistoryRepository, 'insertGrab'>;
}

export interface GrabArgs {
  mediaId: number;
  client: DownloadClientRow;
  mediaType: 'movie' | 'series';
  /** Free-form label for logs, e.g. `"Dune (2021)"` or `"Show S01E03"`. */
  label: string;
  sourceTitle: string;
  downloadUrl: string;
  /** No id→name quality registry host method exists (see port report) —
   *  callers pass the display string to persist; the search/auto-grab paths
   *  the scored release carries the display name; the numeric id renders as a digit. */
  quality: string;
  /** Release size in bytes as the indexer reported it; 0/undefined stores null. */
  size?: number | null;
  indexerId?: number | null;
  grabSource: GrabSource;
  seasonNumber?: number;
  episodeNumber?: number;
  seasonId?: number | null;
  episodeId?: number | null;
  /** Off for user-driven grabs, where re-adding a release on purpose is
   *  legitimate — mirrors `DownloadClientDriver.addTorrentUrl`'s own flag. */
  rejectIfAlreadyPresent?: boolean;
}

/**
 * Ported from `AutoGrabExecutorService.grabAndRecord` /
 * `MovieDownloadService.grabMovie` / `EpisodeDownloadService.grabEpisode`'s
 * shared tail (`auto-grab-pipeline.service.ts`, `movie-download.service.ts`,
 * `episode-download.service.ts`): add the torrent to the client, persist the
 * `download_history` row, publish the grab event, dispatch the
 * `grab.started` notification. `torrentHash` is critical — the completion +
 * stalled + seed cleaners key off `history.torrentHash` first and fall back
 * to fragile `sourceTitle` matching otherwise.
 *
 * Throws on a driver failure — matches the manual-grab call sites, which
 * never caught it. Auto-grab paths wrap this in {@link tryGrabAndRecord}
 * instead, mirroring how the original split "manual grab" (throws) from
 * `AutoGrabExecutorService.grabAndRecord` (catches, returns a boolean).
 */
export async function grabAndRecord(deps: GrabExecutorDeps, args: GrabArgs): Promise<{ torrentHash: string }> {
  log.info(`AutoGrab[${args.mediaType}]: sending "${args.sourceTitle}" to the download client — ${args.downloadUrl}`);
  const torrentHash = await deps.driver.addTorrentUrl(
    args.client,
    args.downloadUrl,
    args.mediaType,
    args.rejectIfAlreadyPresent,
  );

  await deps.historyRepo.insertGrab(
    buildGrabHistoryRow({
      mediaId: args.mediaId,
      downloadClientId: args.client.id,
      sourceTitle: args.sourceTitle,
      torrentHash,
      size: args.size,
      quality: args.quality,
      grabSource: args.grabSource,
      indexerId: args.indexerId,
      seasonId: args.seasonId,
      episodeId: args.episodeId,
    }),
  );

  // Pure notification for an already-recorded grab — a slow/failed publish must never
  // fail the grab itself or duplicate the history row on retry.
  void deps.host
    .call('events.publish', [
      {
        type: 'acquisition.grabbed',
        mediaId: args.mediaId,
        seasonNumber: args.seasonNumber,
        episodeNumber: args.episodeNumber,
      },
    ])
    .catch((e: Error) => log.warn(`AutoGrab: events.publish failed: ${e.message}`));

  void deps.host
    .call('notifications.dispatch', {
      event: 'grab.started',
      payload: { title: args.label, quality: args.quality, sourceTitle: args.sourceTitle },
    })
    .catch((e: Error) => log.warn(`AutoGrab: notifications.dispatch failed: ${e.message}`));

  log.info(`AutoGrab[${args.mediaType}]: grabbed "${args.sourceTitle}" for "${args.label}"`);
  return { torrentHash };
}

/** Catches and logs rather than throwing — for auto-grab sources (SearchMissing,
 *  RssSync) that must not let one candidate's failure kill the whole batch. */
export async function tryGrabAndRecord(deps: GrabExecutorDeps, args: GrabArgs): Promise<boolean> {
  try {
    await grabAndRecord(deps, args);
    return true;
  } catch (e) {
    log.warn(`AutoGrab[${args.mediaType}]: grab failed for "${args.label}": ${(e as Error).message}`);
    return false;
  }
}

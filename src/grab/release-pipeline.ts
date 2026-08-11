import type { IndexerDriver } from '../seams/indexers';
import type { DownloadClientDriver } from '../download-clients/contract';
import type { IndexersRepository, DownloadClientsRepository, DownloadHistoryRepository, BlocklistRepository } from '../db/repositories';
import type { DownloadClientRow } from '../db/rows';
import type { IndexerRelease } from '../indexers/types';
import type { HostCaller } from './types';
import type { HostResult } from '../host-client';
import {
  buildScoreRequest,
  joinScored,
  pickRelease,
  type RankedRelease,
} from './release-scoring';
import { searchMovieAcrossIndexers, searchSeasonPackAcrossIndexers, searchSeriesAcrossIndexers } from './release-search';
import { grabAndRecord, type GrabExecutorDeps } from './grab-executor';
import { log } from '../log';

export type AcquisitionTarget = NonNullable<HostResult<'media.acquisitionContext'>>;

/** i18n-key-carrying error — never a literal message. `detail` is the dynamic
 *  half (a title, a quality id), same split as `ScoredRelease.rejections[]`. */
export class GrabError extends Error {
  constructor(
    readonly messageKey: string,
    readonly detail?: string,
  ) {
    super(detail ? `${messageKey}: ${detail}` : messageKey);
  }
}

export interface ReleasePipelineDeps {
  host: HostCaller;
  indexer: IndexerDriver;
  driver: DownloadClientDriver;
  indexersRepo: Pick<IndexersRepository, 'listEnabled'>;
  clientsRepo: Pick<DownloadClientsRepository, 'listEnabled'>;
  historyRepo: Pick<DownloadHistoryRepository, 'insertGrab'>;
  /** The plugin's own `blocklist` table — core cannot see it, so every
   *  `releases.score` call declares `blocked` per release itself
   *  (`src/host-methods.ts`'s doc-comment on that field). */
  blocklistRepo: Pick<BlocklistRepository, 'isBlocked'>;
}

function execDeps(deps: ReleasePipelineDeps): GrabExecutorDeps {
  return { host: deps.host, driver: deps.driver, historyRepo: deps.historyRepo };
}

/** Ported from `movie-download.service.ts`'s module-level `inferTitleFromTorrentUrl`. */
function inferTitleFromTorrentUrl(url: string): string {
  if (url.startsWith('magnet:')) {
    const m = url.match(/[?&]dn=([^&]+)/i);
    if (m) {
      try {
        return decodeURIComponent(m[1]!.replace(/\+/g, ' '));
      } catch {
        return m[1]!;
      }
    }
  }
  return url.slice(0, 240);
}

export async function loadTarget(
  deps: Pick<ReleasePipelineDeps, 'host'>,
  mediaId: number,
  seasonId?: number,
  episodeId?: number,
): Promise<AcquisitionTarget> {
  const target = await deps.host.call('media.acquisitionContext', { mediaId, seasonId, episodeId });
  if (!target) throw new GrabError('download.grab.errors.media_not_found', String(mediaId));
  return target;
}

function pickClient(deps: ReleasePipelineDeps, clients: DownloadClientRow[]): DownloadClientRow {
  const client = clients.find((c) => deps.driver.supports(c));
  if (!client) throw new GrabError('download.grab.errors.no_download_client');
  return client;
}

/** Movies get the release year appended (short titles like "Up"/"It" would
 *  otherwise match unrelated hits) — series don't, per the original
 *  `searchQueryForMedia` (movies) vs the bare `searchTitle` (series). */
function searchQuery(target: AcquisitionTarget, customQuery?: string): string {
  const trimmed = customQuery?.trim();
  if (trimmed) return trimmed;
  if (!target.season && !target.episode && target.year) return `${target.searchTitle} ${target.year}`;
  return target.searchTitle;
}

/**
 * Fan out to every ready indexer for `target`'s scope (episode / season pack
 * / movie, mirroring `movie-download.service.ts`'s `searchMovieReleases`,
 * `episode-download.service.ts`'s `searchEpisodeReleases`/`searchSeasonReleases`)
 * then score everything in one `releases.score` call.
 *
 * Local post-search filtering by parsed season/episode
 * (`common/release-parsing`) is not re-implemented: `releases.score` is given
 * the same `seasonNumber`/`episodeNumber` context, so a release belonging to
 * a different episode is assumed to be rejected server-side. The result is
 * used exactly as scored — no client-side re-sort — since the response is
 * already sorted by relevance.
 */
export async function searchScored(deps: ReleasePipelineDeps, target: AcquisitionTarget, customQuery?: string): Promise<RankedRelease[]> {
  const indexers = await deps.indexersRepo.listEnabled();
  if (!indexers.length) return [];

  const externalIds = { imdbId: target.imdbId, tmdbId: target.tmdbId, tvdbId: target.tvdbId };
  const query = searchQuery(target, customQuery);
  const context = target.title;

  let raw: IndexerRelease[];
  if (target.episode) {
    raw = await searchSeriesAcrossIndexers(deps.indexer, indexers, query, target.season!.number, target.episode.number, externalIds, context);
  } else if (target.season) {
    raw = await searchSeasonPackAcrossIndexers(deps.indexer, indexers, query, target.season.number, externalIds, context);
  } else {
    raw = await searchMovieAcrossIndexers(deps.indexer, indexers, query, externalIds, context);
  }
  if (!raw.length) return [];

  const scored = await deps.host.call('releases.score', {
    mediaId: target.mediaId,
    seasonNumber: target.season?.number,
    episodeNumber: target.episode?.number,
    releases: await buildScoreRequest(raw, indexers, deps.blocklistRepo),
  });
  return joinScored(raw, scored);
}

/**
 * Interactive/automatic search — unifies `MovieDownloadService.searchMovieReleases`
 * + `searchUpgradeReleases` and `EpisodeDownloadService.searchEpisodeReleases`
 * + `searchSeasonReleases`. The missing-vs-upgrade split those four upstream
 * methods encoded is now carried entirely by `AcquisitionTarget.want` (its
 * `decision` + rank window cover both cases uniformly), so one function
 * serves every caller; `want: null` (unprofiled, or already satisfied) means
 * nothing to search for.
 */
export async function searchReleases(
  deps: ReleasePipelineDeps,
  mediaId: number,
  seasonId?: number,
  episodeId?: number,
  customQuery?: string,
): Promise<RankedRelease[]> {
  const target = await loadTarget(deps, mediaId, seasonId, episodeId);
  if (!target.want) return [];
  return searchScored(deps, target, customQuery);
}

export interface ManualGrabInput {
  downloadUrl: string;
  sourceTitle?: string;
  indexerId?: number;
}

async function scoreSingleRelease(
  deps: ReleasePipelineDeps,
  target: AcquisitionTarget,
  sourceTitle: string,
  downloadUrl: string,
): Promise<RankedRelease> {
  const fabricated: IndexerRelease = {
    title: sourceTitle,
    downloadUrl,
    indexerId: 0,
    indexerName: '',
    size: 0,
    seeders: 0,
    leechers: 0,
    publishDate: new Date().toISOString(),
    freeleech: false,
    downloadVolumeFactor: 1,
  };
  const scored = await deps.host.call('releases.score', {
    mediaId: target.mediaId,
    seasonNumber: target.season?.number,
    episodeNumber: target.episode?.number,
    releases: await buildScoreRequest([fabricated], [], deps.blocklistRepo),
  });
  const joined = joinScored([fabricated], scored)[0];
  if (!joined) throw new GrabError('download.grab.errors.no_eligible_release');
  return joined;
}

/**
 * Interactive/automatic grab — unifies `MovieDownloadService.grabMovie` +
 * `grabUpgrade` and `EpisodeDownloadService.grabEpisode` (season-pack-first
 * fallback lives in `auto-grab.ts`, mirroring `EpisodeDownloadService.grabSeason`).
 * `dto.downloadUrl` set = manual grab (raw paste, or a specific release the
 * caller already searched and picked — both were the same code path
 * upstream too); unset = auto-pick from a fresh search.
 *
 * A manual grab only checks the quality-profile-allowed + blocklist guard
 * upstream also enforced — it does not re-run the full `rejections` array
 * (seeders/size heuristics that don't apply to a user-supplied URL). It
 * still requires a profile (`want` non-null) to know `allowed`: `want: null`
 * collapses "unprofiled" and "already satisfied" into one signal this port
 * cannot tell apart, so a manual grab is blocked in both cases — a narrowing
 * versus upstream (which let a manual grab through at cutoff). Flagged in
 * the port report.
 */
export async function grabRelease(
  deps: ReleasePipelineDeps,
  mediaId: number,
  seasonId?: number,
  episodeId?: number,
  manual?: ManualGrabInput,
): Promise<{ torrentHash: string }> {
  const target = await loadTarget(deps, mediaId, seasonId, episodeId);
  const clients = await deps.clientsRepo.listEnabled();
  const client = pickClient(deps, clients);

  if (!target.want) throw new GrabError('download.grab.errors.unprofiled');

  const grabCommon = {
    mediaId,
    client,
    mediaType: target.kind,
    label: target.title,
    seasonNumber: target.season?.number,
    episodeNumber: target.episode?.number,
    seasonId: target.season?.id ?? null,
    episodeId: target.episode?.id ?? null,
  } as const;

  if (manual?.downloadUrl) {
    const sourceTitle = manual.sourceTitle?.trim() || inferTitleFromTorrentUrl(manual.downloadUrl);
    const scored = await scoreSingleRelease(deps, target, sourceTitle, manual.downloadUrl);
    if (scored.blocklisted) throw new GrabError('download.grab.errors.blocklisted', sourceTitle);
    if (!scored.allowed) throw new GrabError('download.grab.errors.quality_not_allowed', scored.qualityName);
    log.info(`Grab #${mediaId} "${target.title}" — manual URL`);
    return grabAndRecord(execDeps(deps), {
      ...grabCommon,
      sourceTitle,
      downloadUrl: manual.downloadUrl,
      quality: scored.qualityName,
      indexerId: manual.indexerId,
      grabSource: 'manual',
    });
  }

  log.info(`Grab #${mediaId} "${target.title}" — auto-pick`);
  const scored = await searchScored(deps, target);
  const pick = pickRelease(scored, target.want);
  if (!pick) throw new GrabError('download.grab.errors.no_eligible_release');
  return grabAndRecord(execDeps(deps), {
    ...grabCommon,
    sourceTitle: pick.title,
    downloadUrl: pick.downloadUrl,
    quality: pick.qualityName,
    indexerId: pick.indexerId,
    grabSource: 'auto',
  });
}

import type { IndexerDriver } from '../seams/indexers';
import type { DownloadClientDriver } from '../download-clients/contract';
import type { IndexersRepository, DownloadClientsRepository, DownloadHistoryRepository, BlocklistRepository } from '../db/repositories';
import type { DownloadClientRow, IndexerRow } from '../db/rows';
import type { IndexerRelease } from '../indexers/types';
import type { HostCaller } from './types';
import type { HostResult } from '../host-client';
import {
  buildScoreRequest,
  joinScored,
  pickRelease,
  toWireRelease,
  type RankedRelease,
} from './release-scoring';
import {
  searchMovieAcrossIndexers,
  searchSeasonPackAcrossIndexers,
  searchSeriesAcrossIndexers,
  type FanOutHooks,
} from './release-search';
import { createSearchStreamer, type StreamTarget } from './search-stream';
import { refreshSearchBudget } from '../search-budget';
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
  // A special is published under its own title, never as `S00E03`, so the title is the query.
  const specialTitle = isSpecial(target) ? target.episode?.title?.trim() : undefined;
  if (specialTitle) return `${target.searchTitle} ${specialTitle}`;
  return target.searchTitle;
}

/** Season 0: the numbering an indexer understands does not exist for these. */
function isSpecial(target: AcquisitionTarget): boolean {
  return target.season?.number === 0;
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
export async function searchScored(
  deps: ReleasePipelineDeps,
  target: AcquisitionTarget,
  customQuery?: string,
  stream?: StreamTarget,
): Promise<RankedRelease[]> {
  const indexers = await deps.indexersRepo.listEnabled();
  if (!indexers.length) return [];

  await refreshSearchBudget(deps.host);

  const externalIds = { imdbId: target.imdbId, tmdbId: target.tmdbId, tvdbId: target.tvdbId };
  const query = searchQuery(target, customQuery);
  const context = target.title;

  const rank = (releases: IndexerRelease[]) => rankReleases(deps, target, indexers, releases);

  let hooks: FanOutHooks | undefined;
  if (stream) {
    const seen: IndexerRelease[] = [];
    const streamer = createSearchStreamer({
      host: deps.host,
      target: stream,
      rank: async () => (await rank(seen)).map(toWireRelease),
    });
    hooks = {
      onRoster: (ready, skipped) => streamer.roster(ready, skipped),
      onSettled: (ix, outcome) => {
        if ('releases' in outcome) seen.push(...outcome.releases);
        streamer.settled(ix, outcome);
      },
    };
  }

  // Nothing an indexer can be asked for: a specials pack is not a thing anyone publishes, and
  // a special with no title leaves only the series name — which matches its whole catalogue and
  // would let an unrelated release through, since a release naming no episode is never rejected
  // as the wrong one.
  if (isSpecial(target) && !target.episode?.title?.trim()) {
    log.info(
      `Search skipped for "${target.title}" ${target.episode ? `S00E${String(target.episode.number).padStart(2, '0')}` : 'S00 pack'}: no episode title to search a special by`,
    );
    return [];
  }

  let raw: IndexerRelease[];
  if (target.episode) {
    raw = await searchSeriesAcrossIndexers(deps.indexer, indexers, query, target.season!.number, target.episode.number, externalIds, context, hooks);
  } else if (target.season) {
    raw = await searchSeasonPackAcrossIndexers(deps.indexer, indexers, query, target.season.number, externalIds, context, hooks);
  } else {
    raw = await searchMovieAcrossIndexers(deps.indexer, indexers, query, externalIds, context, hooks);
  }
  if (!raw.length) return [];

  return rank(raw);
}

/** One `releases.score` round trip over exactly the releases handed in. Called once per
 *  search for the HTTP answer, and once more per indexer that adds results while a
 *  streamed search fills in — core's sort needs the whole set, not a merge of batches. */
async function rankReleases(
  deps: Pick<ReleasePipelineDeps, 'host' | 'blocklistRepo'>,
  target: AcquisitionTarget,
  indexers: IndexerRow[],
  releases: IndexerRelease[],
): Promise<RankedRelease[]> {
  if (!releases.length) return [];
  const scored = await deps.host.call('releases.score', {
    mediaId: target.mediaId,
    seasonNumber: target.season?.number,
    episodeNumber: target.episode?.number,
    releases: await buildScoreRequest(releases, indexers, deps.blocklistRepo),
  });
  return joinScored(releases, scored);
}

/**
 * Interactive/automatic search — unifies `MovieDownloadService.searchMovieReleases`
 * + `searchUpgradeReleases` and `EpisodeDownloadService.searchEpisodeReleases`
 * + `searchSeasonReleases`. The missing-vs-upgrade split those four upstream
 * methods encoded is now carried entirely by `AcquisitionTarget.want` (its
 * `decision` + rank window cover both cases uniformly), so one function
 * serves every caller. A search runs for any non-null `want`, `decision: 'skip'` included.
 */
export async function searchReleases(
  deps: ReleasePipelineDeps,
  mediaId: number,
  seasonId?: number,
  episodeId?: number,
  customQuery?: string,
  stream?: StreamTarget,
): Promise<RankedRelease[]> {
  const target = await loadTarget(deps, mediaId, seasonId, episodeId);
  if (!target.want) throw new GrabError('download.grab.errors.unprofiled');
  const scored = await searchScored(deps, target, customQuery, stream);
  const satisfied = target.want.decision === 'skip' ? ' (profile already satisfied)' : '';
  log.info(`Search #${mediaId} "${target.title}"${satisfied} q="${searchQuery(target, customQuery)}" → ${scored.length} result(s)`);
  return scored;
}

export interface ManualGrabInput {
  downloadUrl: string;
  sourceTitle?: string;
  indexerId?: number;
  /** Bypasses the quality-not-allowed refusal only; a blocklisted release is never forceable. */
  force?: boolean;
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
 * (seeders/size heuristics that don't apply to a user-supplied URL).
 * `manual.force` opts out of the quality-not-allowed refusal only; the
 * blocklist refusal is never forceable.
 */
export async function grabRelease(
  deps: ReleasePipelineDeps,
  mediaId: number,
  seasonId?: number,
  episodeId?: number,
  manual?: ManualGrabInput,
): Promise<{ torrentHash: string; torrentHashes?: string[] }> {
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
    if (!scored.allowed && !manual.force) throw new GrabError('download.grab.errors.quality_not_allowed', scored.qualityName);
    log.info(`Grab #${mediaId} "${target.title}" — manual URL${!scored.allowed ? ' (forced)' : ''}`);
    return grabAndRecord(execDeps(deps), {
      ...grabCommon,
      sourceTitle,
      downloadUrl: manual.downloadUrl,
      quality: scored.qualityName,
      size: scored.size,
      indexerId: manual.indexerId,
      grabSource: 'manual',
    });
  }

  log.info(`Grab #${mediaId} "${target.title}" — auto-pick`);
  const scored = await searchScored(deps, target);
  const pick = pickRelease(scored, target.want);

  // Season scope with no pack at the top: core's sort already ranks quality
  // above pack-ness, so loose episodes winning means they beat every pack.
  if (target.season && !target.episode && !pick?.isFullSeason) {
    return grabSeasonEpisodes(deps, target, pick ? 'loose episodes outrank every pack' : 'no eligible season release');
  }

  if (!pick) throw new GrabError('download.grab.errors.no_eligible_release');
  return grabAndRecord(execDeps(deps), {
    ...grabCommon,
    sourceTitle: pick.title,
    downloadUrl: pick.downloadUrl,
    quality: pick.qualityName,
    size: pick.size,
    indexerId: pick.indexerId,
    grabSource: 'auto',
  });
}

/** Every episode of `target`'s season core still lists as needing a grab,
 *  in airing order. */
async function seasonEpisodeTargets(
  deps: Pick<ReleasePipelineDeps, 'host'>,
  target: AcquisitionTarget,
): Promise<AcquisitionTarget[]> {
  const availableOn = new Date().toISOString().slice(0, 10);
  const out: AcquisitionTarget[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await deps.host.call('acquisition.candidates', {
      mediaIds: [target.mediaId],
      availableOn,
      limit: 200,
      cursor: cursor ?? undefined,
    });
    for (const it of page.items) {
      if (it.episode && it.season?.id === target.season?.id && it.want && it.want.decision !== 'skip') out.push(it);
    }
    cursor = page.cursor;
  } while (cursor);
  return out.sort((a, b) => a.episode!.number - b.episode!.number);
}

/**
 * The per-episode half of a season grab: no pack was worth taking, so each
 * still-wanted episode runs its own search/score/pick. One episode with no
 * eligible release must not sink the rest, so failures are logged and
 * skipped; only an all-empty run is an error.
 */
async function grabSeasonEpisodes(
  deps: ReleasePipelineDeps,
  target: AcquisitionTarget,
  why: string,
): Promise<{ torrentHash: string; torrentHashes: string[] }> {
  const seasonLabel = `S${String(target.season?.number ?? 0).padStart(2, '0')}`;
  const episodes = await seasonEpisodeTargets(deps, target);
  log.info(`Grab #${target.mediaId} "${target.title}" ${seasonLabel} — ${why}, grabbing ${episodes.length} episode(s) individually`);

  const torrentHashes: string[] = [];
  for (const ep of episodes) {
    const epLabel = `${seasonLabel}E${String(ep.episode!.number).padStart(2, '0')}`;
    try {
      const { torrentHash } = await grabRelease(deps, target.mediaId, target.season!.id, ep.episode!.id);
      torrentHashes.push(torrentHash);
    } catch (err) {
      log.warn(`Grab #${target.mediaId} "${target.title}" ${epLabel} skipped — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!torrentHashes.length) throw new GrabError('download.grab.errors.no_eligible_release');
  return { torrentHash: torrentHashes[0]!, torrentHashes };
}

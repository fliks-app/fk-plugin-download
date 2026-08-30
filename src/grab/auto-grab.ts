import type { ReleasePipelineDeps, AcquisitionTarget } from './release-pipeline';
import { pickRelease } from './release-scoring';
import { tryGrabAndRecord, type GrabExecutorDeps } from './grab-executor';
import type { DownloadClientRow } from '../db/rows';
import { log } from '../log';

function execDeps(deps: ReleasePipelineDeps): GrabExecutorDeps {
  return { host: deps.host, driver: deps.driver, historyRepo: deps.historyRepo };
}

/**
 * Ported from `AutoGrabExecutorService.tryAutoGrab`
 * (`auto-grab-pipeline.service.ts`) — the shared execution tail for every
 * auto-grab source (SearchMissing movies/episodes/season-packs, RssSync).
 * `target.want` already carries what `AutoGrabPipelineService.classifyForSearch`
 * used to compute (missing/upgrade + rank window); this function's own job is
 * search, score, dedup-check, pick, and grab — same order as upstream.
 *
 * `pendingCheck` mirrors each scheduler call site's own dedup query (exact
 * source-title, episode-tag ILIKE, season-pack-by-seasonId) — passed in
 * rather than re-derived here, matching how upstream threaded a closure of
 * the same shape into `tryAutoGrab`'s `pendingCheck` argument.
 */
export async function tryAutoGrab(
  deps: ReleasePipelineDeps,
  target: AcquisitionTarget,
  client: DownloadClientRow,
  searchScored: (target: AcquisitionTarget) => Promise<import('./release-scoring').RankedRelease[]>,
  pendingCheck?: () => Promise<boolean>,
): Promise<boolean> {
  const logSkip = (reason: string): boolean => {
    log.info(`AutoGrab[${target.kind}]: "${target.title}" skipped — ${reason}`);
    return false;
  };

  if (!target.want) return logSkip('no quality/language profile on media');
  if (target.want.decision === 'skip') return logSkip('media already satisfies its profile');
  if (pendingCheck && (await pendingCheck())) return logSkip('a grab is already pending');

  const scored = await searchScored(target);
  if (!scored.length) return logSkip('no releases returned by indexers');

  const pick = pickRelease(scored, target.want);

  // A season-scoped search that a loose episode wins means no pack was worth taking. Grabbing it
  // would record one episode as the whole season, and the next run's pending-pack check would then
  // block the season entirely — the season's own episode candidates handle it instead.
  if (pick && target.season && !target.episode && !pick.isFullSeason) {
    return logSkip(`no eligible season pack — best was "${pick.title}", left to the episode candidates`);
  }

  if (!pick) {
    const sample = scored
      .slice(0, 3)
      .map((r) => `"${r.title}" → rank ${r.rank}${r.rejections.length ? ` [${r.rejections.map((x) => x.code).join(', ')}]` : ''}`)
      .join(' | ');
    return logSkip(`no eligible release (${scored.length} checked)${sample ? ` — top: ${sample}` : ''}`);
  }

  return tryGrabAndRecord(execDeps(deps), {
    mediaId: target.mediaId,
    client,
    mediaType: target.kind,
    label: target.title,
    sourceTitle: pick.title,
    downloadUrl: pick.downloadUrl,
    quality: pick.qualityName,
    size: pick.size,
    infoUrl: pick.infoUrl,
    indexerId: pick.indexerId,
    grabSource: 'auto',
    seasonNumber: target.season?.number,
    episodeNumber: target.episode?.number,
    seasonId: target.season?.id ?? null,
    episodeId: target.episode?.id ?? null,
    // Only the scheduler/RSS path rejects a hash the client already holds —
    // interactive grabs (`release-pipeline.ts`) leave this off.
    rejectIfAlreadyPresent: true,
  });
}

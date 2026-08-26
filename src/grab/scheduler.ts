import { type ReleasePipelineDeps, type AcquisitionTarget, searchScored } from './release-pipeline';
import { tryAutoGrab } from './auto-grab';
import { identifyOrphans } from './orphan-matcher';
import type { HostCaller } from './types';
import type { DownloadClientRow } from '../db/rows';
import type { DownloadHistoryRepository } from '../db/repositories';
import { rssAcrossIndexers, readyIndexersOrNone } from './release-search';
import { log } from '../log';

export interface SchedulerDeps extends ReleasePipelineDeps {
  host: HostCaller;
  historyRepo: DownloadHistoryRepository;
}

function pickClient(deps: SchedulerDeps, clients: DownloadClientRow[]): DownloadClientRow | null {
  return clients.find((c) => deps.driver.supports(c)) ?? null;
}

/**
 * Ported from `AcquisitionSchedulerService.searchMissing`
 * (`acquisition-scheduler.service.ts`). Upstream's own candidate listing
 * (`AcquisitionCandidatesService.listMovieTargets`/`listEpisodeTargets` +
 * `groupIntoSeasonPacks`) is assumed folded into `acquisition.candidates` —
 * core is assumed to already return season-pack-vs-per-episode candidates at
 * the right granularity (an `AcquisitionTarget` with `episode` set is a
 * single episode; with only `season` set, a pack). This plugin does not
 * re-derive pack grouping. Flagged as a trust assumption in the port report.
 */
export async function searchMissing(deps: SchedulerDeps, mediaIds?: number[]): Promise<void> {
  const clients = await deps.clientsRepo.listEnabled();
  const client = pickClient(deps, clients);
  if (!client) {
    log.warn('SearchMissing: no enabled download client configured');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  let cursor: string | null | undefined;
  let count = 0;
  // Core lists a season's pack and its episodes, pack first, so a pack taken here must stop its
  // own episodes being taken behind it. Spans pages: the sort keeps them in that order.
  const seasonsGrabbedAsPack = new Set<number>();
  do {
    const page = await deps.host.call('acquisition.candidates', { mediaIds, availableOn: today, limit: 200, cursor: cursor ?? undefined });
    for (const target of page.items) {
      count++;
      if (!target.want || target.want.decision === 'skip') continue;
      if (target.episode && target.season && seasonsGrabbedAsPack.has(target.season.id)) continue;
      const grabbed = await tryAutoGrab(deps, target, client, (t) => searchScored(deps, t), () => pendingCheck(deps.historyRepo, target));
      if (grabbed && target.season && !target.episode) seasonsGrabbedAsPack.add(target.season.id);
    }
    cursor = page.cursor;
  } while (cursor);

  log.info(`SearchMissing: ${count} candidate(s) checked`);
}

/** Mirrors each scheduler call site's own dedup query — season-pack-by-id
 *  when the target is season-scoped with no episode, episode-tag ILIKE for a
 *  single episode, else the plain "pending grab for this media" check. */
async function pendingCheck(historyRepo: DownloadHistoryRepository, target: AcquisitionTarget): Promise<boolean> {
  if (target.season && !target.episode) {
    const pending = await historyRepo.findPendingSeasonPackGrab(target.mediaId, target.season.id);
    return !!pending;
  }
  if (target.season && target.episode) {
    // A pack still downloading from an earlier run covers this episode, and its source title
    // ("Show.S01.1080p") never matches the episode pattern below.
    if (await historyRepo.findPendingSeasonPackGrab(target.mediaId, target.season.id)) return true;
    const epLabel = `S${String(target.season.number).padStart(2, '0')}E${String(target.episode.number).padStart(2, '0')}`;
    const pending = await historyRepo.findPendingEpisodeGrab(target.mediaId, `%${epLabel}%`);
    return !!pending;
  }
  const pending = await historyRepo.findPendingGrabForMedia(target.mediaId);
  return !!pending;
}

/**
 * Ported from `AcquisitionSchedulerService.rssSync`. Partial: identification
 * and the missing/upgrade/availability/delay-profile decision are delegated
 * to `releases.match` (this plugin has no access to `DelayProfile`/media
 * entities to re-derive them); season/episode **ids** for a `'grab'` decision
 * are recovered with the same best-effort `acquisition.candidates` round trip
 * as the orphan matcher (`orphan-matcher.ts`), so a release matching a
 * season/episode core no longer lists as an open candidate is skipped rather
 * than grabbed with a null id. The original's season-pack-vs-episode
 * same-pull/cross-pull suppression (`packTriedThisPull`,
 * `hasRecentSeasonPackGrab`) is not reproduced: `releases.match` already
 * returns `isFullSeason` and `decision`, and is assumed to apply the
 * equivalent priority server-side. This is the least-ported piece of the
 * brief — see the port report.
 */
export async function rssSync(deps: SchedulerDeps): Promise<void> {
  const indexers = await deps.indexersRepo.listEnabled();
  const clients = await deps.clientsRepo.listEnabled();
  const client = pickClient(deps, clients);
  if (!client) {
    log.warn('RssSync: no enabled download client configured');
    return;
  }
  const ready = readyIndexersOrNone(deps.indexer, indexers, 'RssSync');
  if (!ready.length) return;

  const feeds = await rssAcrossIndexers(deps.indexer, ready, 'RssSync');
  for (const { releases } of feeds) {
    if (!releases.length) continue;
    const matched = await identifyOrphans(
      deps.host,
      releases.map((r) => r.title),
    );

    for (const release of releases) {
      const m = matched.get(release.title);
      if (!m || m.mediaId == null) continue;

      // The contract's own ceiling, not 100: a series with more open candidates than one page had
      // its highest seasons — the ones a feed actually carries — silently off the end of it.
      const page = await deps.host.call('acquisition.candidates', {
        mediaIds: [m.mediaId],
        availableOn: new Date().toISOString().slice(0, 10),
        limit: 500,
      });
      const target = page.items.find((it) => (m.seasonNumber == null ? !it.season : it.season?.number === m.seasonNumber) && (m.episodeNumber == null ? !it.episode : it.episode?.number === m.episodeNumber));
      if (!target || !target.want || target.want.decision === 'skip') {
        if (!target && page.cursor) {
          log.warn(`RssSync: "${release.title}" matched #${m.mediaId} but its candidate was past the first page — skipped`);
        }
        continue;
      }

      await tryAutoGrab(deps, target, client, (t) => searchScored(deps, t), () => pendingCheck(deps.historyRepo, target));
    }
  }
}

import type { ReleasePipelineDeps } from './release-pipeline';
import { grabRelease, searchReleases, type ManualGrabInput } from './release-pipeline';
import { searchMissing, rssSync } from './scheduler';
import type { DownloadHistoryRepository } from '../db/repositories';

export type GrabPipelineDeps = ReleasePipelineDeps & { historyRepo: DownloadHistoryRepository };

/**
 * Wires `release-pipeline.ts` (interactive search + grab, ported from
 * `movie-download.service.ts` + `episode-download.service.ts`) and
 * `scheduler.ts` (ported from `acquisition-scheduler.service.ts`) behind one
 * object. This is the concrete class behind `src/seams/grab-pipeline.ts`'s
 * `GrabPipeline` interface — its public surface is wider than that interface
 * (see the port report): `searchReleases`/`grabRelease` for the interactive
 * HTTP routes (`GET /:id/releases`, `POST /:id/grab`, and the season/episode
 * siblings — `scripts/manifest-template.ts`'s `ROUTES`, wired by whoever owns
 * `src/seams/http-routes.ts`), plus the three methods the `GrabPipeline`
 * interface declares for job/note wiring.
 */
export class DownloadGrabPipeline {
  constructor(private readonly deps: GrabPipelineDeps) {}

  searchReleases(mediaId: number, seasonId?: number, episodeId?: number, customQuery?: string) {
    return searchReleases(this.deps, mediaId, seasonId, episodeId, customQuery);
  }

  grabRelease(mediaId: number, seasonId?: number, episodeId?: number, manual?: ManualGrabInput) {
    return grabRelease(this.deps, mediaId, seasonId, episodeId, manual);
  }

  /** `GrabPipeline.searchAndGrab` — auto-pick and grab one target. Backs the
   *  inbound `media.acquisition.requested` note's targeted-restart use case
   *  and the manifest's `POST /:id/grab`-family routes when called without a
   *  manual URL. */
  async searchAndGrab(mediaId: number, seasonId?: number, episodeId?: number): Promise<void> {
    await grabRelease(this.deps, mediaId, seasonId, episodeId);
  }

  /** `GrabPipeline.searchMissing` — the `SearchMissing` job. */
  searchMissing(mediaIds?: number[]): Promise<void> {
    return searchMissing(this.deps, mediaIds);
  }

  /** `GrabPipeline.rssSync` — the `RssSync` job. */
  rssSync(): Promise<void> {
    return rssSync(this.deps);
  }
}

export function createGrabPipeline(deps: GrabPipelineDeps): DownloadGrabPipeline {
  return new DownloadGrabPipeline(deps);
}

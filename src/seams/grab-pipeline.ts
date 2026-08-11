/**
 * Lands `movie-download.service.ts` + `episode-download.service.ts` + the
 * search half of `auto-grab-pipeline.service.ts` (scoring/candidate calls
 * served by `releases.score` and `acquisition.candidates` — see
 * `src/host-methods.ts`) and `acquisition-scheduler.service.ts`. Real logic
 * lives in `src/grab/**`; this file is the wiring point for whoever connects
 * `SearchMissing`/`RssSync` job dispatch (`src/seams/jobs.ts`) and the
 * inbound `media.acquisition.requested` note (`src/plugin.ts`) to it — both
 * out of scope here.
 *
 * Broadened from its original one-method scaffold to one method per manifest
 * job (`SearchMissing`, `RssSync`) plus the targeted single-media action —
 * see `src/grab/pipeline.ts`'s `DownloadGrabPipeline` for the fuller surface
 * (interactive search/grab) a future `src/seams/http-routes.ts` wiring needs.
 */
export interface GrabPipeline {
  /** Auto-pick and grab one target — the inbound `media.acquisition.requested`
   *  note's per-media restart, and `POST /:id/grab`-family routes called
   *  without a manual URL. `seasonId`/`episodeId` are core ids, not numbers. */
  searchAndGrab(mediaId: number, seasonId?: number, episodeId?: number): Promise<void>;
  /** The `SearchMissing` job. */
  searchMissing(mediaIds?: number[]): Promise<void>;
  /** The `RssSync` job. */
  rssSync(): Promise<void>;
}

export { DownloadGrabPipeline, createGrabPipeline, type GrabPipelineDeps } from '../grab/pipeline';

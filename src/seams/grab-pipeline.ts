/** Lands `movie-download.service.ts` + `episode-download.service.ts` + the search half of
 *  `auto-grab-pipeline.service.ts` (scoring/candidate calls already served by `releases.score`
 *  and `acquisition.candidates` — see `src/host-methods.ts`). Empty on purpose. */
export interface GrabPipeline {
  searchAndGrab(mediaId: number, seasonNumber?: number, episodeNumber?: number): Promise<void>;
}

import type { HostCaller } from './types';

/**
 * Replaces `TorrentAutoMatcher` (`torrent-auto-matcher.service.ts`) — the
 * original's bespoke fuzzy-title SQL matcher (`regexp_replace` over
 * `title`/`originalTitle`/`alternativeTitles`) is core-only knowledge this
 * plugin has no access to, so identification is delegated to `releases.match`
 * instead. This is a real behavioural swap, not a like-for-like port: core's
 * matcher may have different ambiguity/ranking rules than
 * `TorrentAutoMatcher.lookupMedia`'s alphanumeric-key + year-tiebreak logic.
 */
export interface OrphanMatch {
  mediaId: number;
  seasonNumber?: number;
  episodeNumber?: number;
  isFullSeason: boolean;
}

/** Batches every unidentified torrent name into one `releases.match` call.
 *  Returns a match per input title, keyed by the exact string passed in —
 *  `null` when core found no media for it (mirrors `TorrentAutoMatcher.tryMatch`
 *  returning `null` on ambiguity/no match). */
export async function identifyOrphans(host: HostCaller, titles: string[]): Promise<Map<string, OrphanMatch | null>> {
  const out = new Map<string, OrphanMatch | null>();
  if (!titles.length) return out;
  const results = await host.call('releases.match', {
    titles: titles.map((title, i) => ({ id: String(i), title, publishDate: new Date().toISOString() })),
  });
  for (const r of results) {
    const title = titles[Number(r.id)];
    if (title === undefined) continue;
    out.set(title, r.mediaId == null ? null : { mediaId: r.mediaId, seasonNumber: r.seasonNumber, episodeNumber: r.episodeNumber, isFullSeason: r.isFullSeason });
  }
  return out;
}

/**
 * Best-effort season/episode **id** lookup for a match that only carries
 * **numbers** (`releases.match`'s response shape — see `src/host-methods.ts`).
 * `download_history.seasonId`/`episodeId` are real core ids, so this re-queries
 * `acquisition.candidates` scoped to the one matched media and looks for the
 * item whose season/episode number matches.
 *
 * This only finds an id when core still lists the season/episode as an open
 * candidate (missing or upgrade-eligible) — an orphan duplicating an
 * already-satisfied episode leaves both ids `null`, same as the original
 * falling back to a season-only or fully-unbound row when its own lookup came
 * up short. `mediaId` is unaffected either way; only the finer link is lost.
 */
export async function resolveSeasonEpisodeIds(
  host: HostCaller,
  mediaId: number,
  seasonNumber?: number,
  episodeNumber?: number,
): Promise<{ seasonId: number | null; episodeId: number | null }> {
  if (seasonNumber == null) return { seasonId: null, episodeId: null };
  const today = new Date().toISOString().slice(0, 10);
  const { items } = await host.call('acquisition.candidates', { mediaIds: [mediaId], availableOn: today, limit: 500 });
  const bySeason = items.filter((it) => it.season?.number === seasonNumber);

  if (episodeNumber != null) {
    const withEpisode = bySeason.find((it) => it.episode?.number === episodeNumber);
    if (withEpisode?.season && withEpisode.episode) return { seasonId: withEpisode.season.id, episodeId: withEpisode.episode.id };
  }
  const anySeason = bySeason.find((it) => it.season);
  return anySeason?.season ? { seasonId: anySeason.season.id, episodeId: null } : { seasonId: null, episodeId: null };
}

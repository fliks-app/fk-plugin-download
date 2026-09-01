import type { IndexerRelease } from '../indexers/types';
import type { IndexerRow } from '../db/rows';
import type { BlocklistRepository } from '../db/repositories';
import type { HostParams, HostResult } from '../host-client';

export type ScoreReleaseInput = HostParams<'releases.score'>['releases'][number];
export type ScoredRelease = HostResult<'releases.score'>[number];
export type AcquisitionWant = NonNullable<HostResult<'media.acquisitionContext'>>['want'];

/**
 * Builds one `releases.score` release entry per indexer hit. Everything about
 * quality/language/custom-format scoring now lives server-side (core owns
 * the registries) — the per-release data this plugin still has to attach is
 * what only IT knows: the issuing indexer's own
 * `minSeeders`/`unknownLanguageIsoCode` settings (`buildIndexerMinSeeders` /
 * the `indexerUnknownLang` map in the original `movie-download.service.ts` /
 * `episode-download.service.ts`), and — per `releases.score`'s `blocked`
 * field doc-comment in `src/host-methods.ts` ("This plugin owns the
 * blocklist table, so core cannot know — it asks") — whether the release's
 * exact title is in the plugin's own `blocklist` table.
 *
 * `id` is the array index, stringified — this plugin controls both sides of
 * the correlation, so no natural per-release id is needed. `sourceRef` uses
 * the release's `downloadUrl`: the contract names no other candidate value.
 */
export async function buildScoreRequest(
  releases: IndexerRelease[],
  indexers: IndexerRow[],
  blocklistRepo: Pick<BlocklistRepository, 'isBlocked'>,
): Promise<ScoreReleaseInput[]> {
  const byIndexer = new Map(indexers.map((ix) => [ix.id, ix]));
  return Promise.all(
    releases.map(async (r, i) => {
      const settings = byIndexer.get(r.indexerId)?.settings ?? {};
      const minSeeders = Number(settings['minSeeders']);
      return {
        id: String(i),
        title: r.title,
        size: r.size,
        seeders: r.seeders,
        leechers: r.leechers,
        publishDate: r.publishDate ?? new Date(0).toISOString(),
        freeleech: r.freeleech,
        downloadVolumeFactor: r.downloadVolumeFactor,
        sourceRef: r.downloadUrl,
        minSeeders: Number.isFinite(minSeeders) && minSeeders > 0 ? minSeeders : undefined,
        unknownLanguageIsoCode: settings['unknownLanguageIsoCode'] as string | undefined,
        blocked: await blocklistRepo.isBlocked(r.title),
      };
    }),
  );
}

/**
 * `releases.score`'s response carries no `title`/`downloadUrl`/`indexerId` —
 * only `id`, the correlation key this plugin chose (the array index into the
 * release list it sent). This re-attaches the raw indexer fields so the
 * grab step has something to hand the download client, while keeping the
 * response's order (already sorted by relevance).
 */
export type RankedRelease = IndexerRelease & ScoredRelease;

export function joinScored(raw: IndexerRelease[], scored: ScoredRelease[]): RankedRelease[] {
  return scored.flatMap((s) => {
    const r = raw[Number(s.id)];
    return r ? [{ ...r, ...s }] : [];
  });
}

/**
 * First release core did not reject. Its response is already sorted by relevance (see the
 * doc-comment in `src/host-methods.ts`), so this is a plain `find`.
 *
 * Every profile rule arrives as a rejection — the allowed qualities, the resolution-upgrade
 * rule, the custom-format floor and the upgrade window. Reapplying one here is what left the
 * resolution rule enforced by neither side; the manifest's `fliks` floor is what makes trusting
 * the rejections safe, since a core that decided less would refuse to load this build.
 */
export function pickRelease<T extends Pick<ScoredRelease, 'rank' | 'rejections'>>(
  sorted: T[],
  want: AcquisitionWant,
): T | undefined {
  return pickReleases(sorted, want)[0];
}

/** How many dead links one grab will walk past before giving up. An indexer handing out broken
 *  URLs should not cost a fetch per candidate it returned. */
export const MAX_RELEASE_ATTEMPTS = 3;

/**
 * Every release eligible under `want`, best first — the same predicate {@link pickRelease}
 * applies, kept as a list so a caller can fall through to the next one when the indexer cannot
 * hand over the file it advertised. Capped: see {@link MAX_RELEASE_ATTEMPTS}.
 */
export function pickReleases<T extends Pick<ScoredRelease, 'rank' | 'rejections'>>(
  sorted: T[],
  want: AcquisitionWant,
  limit = MAX_RELEASE_ATTEMPTS,
): T[] {
  if (!want) return [];
  // A title that already satisfies its profile is searchable by hand, never picked for the user.
  if (want.decision === 'skip') return [];
  return sorted.filter((r) => r.rejections.length === 0).slice(0, limit);
}

/** Core names the release source `sourceId`/`sourceName`; inside this plugin it is an
 *  indexer row. Shared by the HTTP response and the streamed one so both speak the same
 *  shape — a client that had to tell them apart would need two row types. */
export function toWireRelease({ indexerId, indexerName, ...rest }: RankedRelease): Record<string, unknown> {
  return { ...rest, sourceId: indexerId, sourceName: indexerName };
}

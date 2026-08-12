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
 * Ported pick predicate from `AutoGrabExecutorService.tryAutoGrab` in
 * `auto-grab-pipeline.service.ts` (there named inline, not a standalone
 * function): first release with no rejections whose rank falls inside the
 * profile's window. `releases.score`'s response is already sorted by
 * relevance (see its doc-comment in `src/host-methods.ts`), so this is a
 * plain `find`, matching upstream exactly.
 *
 * Upstream additionally re-checked `resolutionUpgradeOnly` against
 * `parseReleaseQuality(title).quality.resolution` — `ScoredRelease` carries no
 * per-release resolution field to reapply that here, so it is assumed folded
 * into `rejections` server-side (`want.resolutionUpgradeOnly` is otherwise
 * unused by this function). Flagged in the port report, not invented.
 */
export function pickRelease<T extends Pick<ScoredRelease, 'rank' | 'rejections'>>(
  sorted: T[],
  want: AcquisitionWant,
): T | undefined {
  if (!want) return undefined;
  // A title that already satisfies its profile is searchable by hand, never picked for the user.
  if (want.decision === 'skip') return undefined;
  return sorted.find((r) => {
    if (r.rejections.length > 0) return false;
    if (r.rank <= want.minRankExclusive || r.rank > want.maxRankInclusive) return false;
    return true;
  });
}

/** `${code}: ${detail}` when present, else just the code — matches
 *  `formatRejectionForLog` in the original `common/release-scoring`. */
export function formatRejectionForLog(r: { code: string; detail?: string }): string {
  return r.detail ? `${r.code}: ${r.detail}` : r.code;
}

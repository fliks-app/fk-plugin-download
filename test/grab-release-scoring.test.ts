/**
 * Release-selection-given-a-scored-list: the first release core did not reject. The upgrade
 * window used to be reapplied here from `want`; core decides it now and reports it as a
 * rejection like every other profile rule. Also covers `joinScored`, the re-attachment of raw
 * indexer fields onto `releases.score`'s response.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickRelease, joinScored, buildScoreRequest, type ScoredRelease } from '../src/grab/release-scoring';
import type { IndexerRelease } from '../src/indexers/types';
import type { IndexerRow } from '../src/db/rows';

function scored(over: Partial<ScoredRelease>): ScoredRelease {
  return {
    id: '0',
    qualityId: 1,
    qualityName: '1080p',
    rank: 10,
    allowed: true,
    customFormatScore: 0,
    blocklisted: false,
    languageId: null,
    languageName: null,
    languageAllowed: true,
    isFullSeason: false,
    sizeDeviation: 0,
    videoCodec: null,
    rejections: [],
    ...over,
  };
}

describe('pickRelease', () => {
  const want = { decision: 'missing' as const, allowedQualityIds: [], allowedLanguageIds: [], minResolution: 0, resolutionUpgradeOnly: false };

  test('picks the first release with no rejections inside the rank window — matching upstream order', () => {
    const sorted = [
      scored({ id: '0', rank: 50, rejections: [{ code: 'size' }] }),
      scored({ id: '1', rank: 40, rejections: [] }),
      scored({ id: '2', rank: 30, rejections: [] }),
    ];
    // "already sorted by relevance" is trusted, not re-derived — the first
    // eligible entry wins regardless of rank ordering among eligible ones.
    assert.equal(pickRelease(sorted, want)?.id, '1');
  });

  test('VERDICT: trusts core on the upgrade window instead of reapplying it', () => {
    // Core reports an out-of-window release as rejected. Re-deriving the bound here is what
    // let the resolution-upgrade rule end up enforced by neither side.
    const outOfWindow = scored({
      id: '0',
      rank: 95,
      rejections: [{ code: 'RANK_ABOVE_CUTOFF', params: { actual: 95, max: 68 } }],
    });
    const inWindow = scored({ id: '1', rank: 30, rejections: [] });
    assert.equal(pickRelease([outOfWindow, inWindow], want)?.id, '1');
  });

  test('skips every release with a rejection, even a high-rank one', () => {
    const sorted = [scored({ id: '0', rank: 90, rejections: [{ code: 'MIN_SEEDERS', params: { actual: 0, min: 5 } }] })];
    assert.equal(pickRelease(sorted, want), undefined);
  });

  test('returns undefined when want is null (unprofiled / already satisfied)', () => {
    const sorted = [scored({ id: '0', rank: 10, rejections: [] })];
    assert.equal(pickRelease(sorted, null), undefined);
  });

  test('returns undefined on an empty list', () => {
    assert.equal(pickRelease([], want), undefined);
  });
});

function release(over: Partial<IndexerRelease>): IndexerRelease {
  return {
    title: 't',
    downloadUrl: 'magnet:?xt=urn:btih:abc',
    indexerId: 1,
    indexerName: 'ix',
    size: 1000,
    seeders: 5,
    leechers: 1,
    publishDate: new Date().toISOString(),
    freeleech: false,
    downloadVolumeFactor: 1,
    ...over,
  };
}

describe('joinScored', () => {
  test('re-attaches raw fields in the scored response order, not the input order', () => {
    const raw = [release({ title: 'A' }), release({ title: 'B' }), release({ title: 'C' })];
    const scoredList = [scored({ id: '2' }), scored({ id: '0' })];
    const joined = joinScored(raw, scoredList);
    assert.deepEqual(joined.map((r) => r.title), ['C', 'A']);
  });

  test('drops a scored entry whose id has no matching raw release', () => {
    const raw = [release({ title: 'A' })];
    const joined = joinScored(raw, [scored({ id: '5' })]);
    assert.equal(joined.length, 0);
  });
});

describe('buildScoreRequest', () => {
  const noneBlocked = { isBlocked: async () => false };

  test('attaches the issuing indexer’s own minSeeders/unknownLanguageIsoCode, never a global default', async () => {
    const indexers: IndexerRow[] = [
      { id: 1, name: 'a', implementation: 'torznab', settings: { minSeeders: 5, unknownLanguageIsoCode: 'en' }, enableRss: true, enableSearch: true, enableInteractiveSearch: true, priority: 1, enabled: true, capsSearchFallback: false,
      capsProbedAt: null, capsMovieSearch: false, capsTvSearch: false, capsMovieSearchParams: null, capsTvSearchParams: null, requestDelay: 2, createdAt: '', updatedAt: '' },
      { id: 2, name: 'b', implementation: 'torznab', settings: {}, enableRss: true, enableSearch: true, enableInteractiveSearch: true, priority: 2, enabled: true, capsSearchFallback: false,
      capsProbedAt: null, capsMovieSearch: false, capsTvSearch: false, capsMovieSearchParams: null, capsTvSearchParams: null, requestDelay: 2, createdAt: '', updatedAt: '' },
    ];
    const req = await buildScoreRequest([release({ indexerId: 1 }), release({ indexerId: 2 })], indexers, noneBlocked);
    assert.equal(req[0]?.minSeeders, 5);
    assert.equal(req[0]?.unknownLanguageIsoCode, 'en');
    assert.equal(req[1]?.minSeeders, undefined);
    assert.equal(req[1]?.unknownLanguageIsoCode, undefined);
  });

  test('declares `blocked` per release from the plugin’s own blocklist table — core cannot see it', async () => {
    const isBlocked = async (title: string) => title === 'Bad.Release';
    const req = await buildScoreRequest([release({ title: 'Good.Release' }), release({ title: 'Bad.Release' })], [], { isBlocked });
    assert.equal(req[0]?.blocked, false);
    assert.equal(req[1]?.blocked, true);
  });
});

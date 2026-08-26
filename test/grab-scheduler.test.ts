/**
 * The two unattended sweep entry points (`SearchMissing`, `RssSync`) must
 * never grab a `decision: 'skip'` target — only `tryAutoGrab`'s own guard
 * (`grab-auto-grab.test.ts`) is downstream of these; this file proves each
 * call site's own guard holds too.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { searchMissing, rssSync } from '../src/grab/scheduler';
import type { SchedulerDeps } from '../src/grab/scheduler';
import type { AcquisitionTarget } from '../src/grab/release-pipeline';
import type { IndexerDriver } from '../src/seams/indexers';
import { FakeHistoryRepo, FakeDriver, FakeHost, FakeBlocklistRepo, makeClient, asHistoryRepo, asBlocklistRepo } from './grab-test-helpers';
import { log } from '../src/log';

/** `tryAutoGrab` has its own downstream skip-decision guard (`auto-grab.ts`) —
 *  capturing its log line is what tells "the scheduler's own guard never even
 *  called it" apart from "it was called and skipped anyway", since both read
 *  identically from the grab outcome alone. */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = log.info;
  log.info = (m: string) => void lines.push(m);
  return { lines, restore: () => (log.info = original) };
}

function target(over: Partial<AcquisitionTarget> = {}): AcquisitionTarget {
  return {
    mediaId: 1,
    kind: 'movie',
    title: 'Movie',
    originalTitle: null,
    alternativeTitles: [],
    year: 2020,
    runtimeMinutes: 100,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    libraryId: 1,
    want: { decision: 'missing', allowedQualityIds: [], allowedLanguageIds: [], minRankExclusive: 0, maxRankInclusive: 100, minResolution: 0, resolutionUpgradeOnly: false },
    expectedTitles: ['Movie'],
    searchTitle: 'Movie',
    ...over,
  };
}

const skipWant = { decision: 'skip' as const, allowedQualityIds: [], allowedLanguageIds: [], minRankExclusive: 0, maxRankInclusive: 100, minResolution: 0, resolutionUpgradeOnly: false };

const indexerRow = { id: 1, name: 'ix', implementation: 'torznab', settings: {}, enableRss: true, enableSearch: true, priority: 1, enabled: true, capsSearchFallback: false, capsMovieSearch: false, capsTvSearch: false, requestDelay: 2, createdAt: '', updatedAt: '' };

function fakeIndexerDriver(releases: { title: string; downloadUrl: string; indexerId: number }[]): IndexerDriver {
  const asReleases = releases.map((r) => ({ ...r, indexerName: 'ix', size: 1000, seeders: 10, leechers: 1, publishDate: new Date().toISOString(), freeleech: false, downloadVolumeFactor: 1 }));
  return {
    searchMovie: async () => asReleases,
    searchSeries: async () => asReleases,
    searchSeasonPack: async () => asReleases,
    rssSearch: async () => asReleases,
    filterReadyIndexers: (ixs) => ixs,
    refreshCaps: async () => undefined,
    testConnection: async () => ({ ok: true, messageKey: 'download.indexers.test.ok' as const }),
  };
}

function buildDeps(opts: { releases?: { title: string; downloadUrl: string; indexerId: number }[]; isFullSeason?: boolean } = {}) {
  const historyRepo = new FakeHistoryRepo();
  const driver = new FakeDriver();
  const host = new FakeHost().on('events.publish', () => undefined).on('notifications.dispatch', () => undefined);
  host.on('releases.score', (p: unknown) => {
    const releases = (p as { releases: { id: string }[] }).releases;
    return releases.map((r) => ({ id: r.id, qualityId: 5, qualityName: '1080p', rank: 30, allowed: true, customFormatScore: 0, blocklisted: false, languageId: null, languageName: null, languageAllowed: true, isFullSeason: opts.isFullSeason ?? false, sizeDeviation: 0, videoCodec: null, rejections: [] }));
  });
  const deps: SchedulerDeps = {
    host,
    indexer: fakeIndexerDriver(opts.releases ?? []),
    driver,
    indexersRepo: { listEnabled: async () => [indexerRow] as never },
    clientsRepo: { listEnabled: async () => [makeClient({ id: 1 })] },
    historyRepo: asHistoryRepo(historyRepo),
    blocklistRepo: asBlocklistRepo(new FakeBlocklistRepo()),
  };
  return { deps, historyRepo, driver, host };
}

describe('searchMissing', () => {
  test('a skip-decision candidate is filtered out before tryAutoGrab is ever called', async () => {
    const { deps, host, historyRepo, driver } = buildDeps({ releases: [{ title: 'Movie.2020.1080p', downloadUrl: 'u1', indexerId: 1 }] });
    host.on('acquisition.candidates', () => ({ items: [target({ want: skipWant })], cursor: null }));
    const capture = captureLogs();
    try {
      await searchMissing(deps);
    } finally {
      capture.restore();
    }
    assert.equal(historyRepo.insertCalls.length, 0);
    assert.equal(driver.added.length, 0);
    assert.ok(!capture.lines.some((l) => l.includes('AutoGrab[')), 'tryAutoGrab must never be entered for a skip-decision candidate');
  });

  test('a missing-decision candidate is still auto-grabbed (sanity control)', async () => {
    const { deps, host, historyRepo } = buildDeps({ releases: [{ title: 'Movie.2020.1080p', downloadUrl: 'u1', indexerId: 1 }] });
    host.on('acquisition.candidates', () => ({ items: [target()], cursor: null }));
    await searchMissing(deps);
    assert.equal(historyRepo.insertCalls.length, 1);
  });
});

describe('rssSync', () => {
  function withMatch(host: ReturnType<typeof buildDeps>['host'], matchedTarget: AcquisitionTarget) {
    host.on('releases.match', () => [{ id: '0', mediaId: matchedTarget.mediaId, isFullSeason: false, decision: 'grab' as const }]);
    host.on('acquisition.candidates', () => ({ items: [matchedTarget], cursor: null }));
  }

  test('a matched skip-decision target is filtered out before tryAutoGrab is ever called', async () => {
    const { deps, host, historyRepo, driver } = buildDeps({ releases: [{ title: 'Movie.2020.1080p', downloadUrl: 'u1', indexerId: 1 }] });
    withMatch(host, target({ want: skipWant }));
    const capture = captureLogs();
    try {
      await rssSync(deps);
    } finally {
      capture.restore();
    }
    assert.equal(historyRepo.insertCalls.length, 0);
    assert.equal(driver.added.length, 0);
    assert.ok(!capture.lines.some((l) => l.includes('AutoGrab[')), 'tryAutoGrab must never be entered for a matched skip-decision target');
  });

  test('a matched missing-decision target is still auto-grabbed (sanity control)', async () => {
    const { deps, host, historyRepo } = buildDeps({ releases: [{ title: 'Movie.2020.1080p', downloadUrl: 'u1', indexerId: 1 }] });
    withMatch(host, target());
    await rssSync(deps);
    assert.equal(historyRepo.insertCalls.length, 1);
  });
});

const SEASON = { id: 20, number: 1 };

/** A season-scoped target (a pack) and one of its episodes, in the order core lists them. */
function packAndEpisode() {
  return [
    target({ kind: 'series', title: 'Show', searchTitle: 'Show', expectedTitles: ['Show'], season: SEASON } as Partial<AcquisitionTarget>),
    target({ kind: 'series', title: 'Show', searchTitle: 'Show', expectedTitles: ['Show'], season: SEASON, episode: { id: 201, number: 3 } } as Partial<AcquisitionTarget>),
  ];
}

describe('searchMissing — a partially available season', () => {
  test('VERDICT: no eligible pack leaves the episodes to be grabbed on their own', async () => {
    // The scorer answers isFullSeason:false, so the pack search finds only loose episodes.
    const { deps, host, historyRepo } = buildDeps({ releases: [{ title: 'Show.S01E03.1080p', downloadUrl: 'u1', indexerId: 1 }] });
    host.on('acquisition.candidates', () => ({ items: packAndEpisode(), cursor: null }));

    await searchMissing(deps);

    // Exactly one grab: the episode. The pack target must not take a loose episode and record
    // it as the season, which is what would block the season on the next run.
    assert.equal(historyRepo.insertCalls.length, 1);
    assert.equal(historyRepo.insertCalls[0]?.episodeId, 201);
  });

  test('VERDICT: a pack that is grabbed stops its own episodes being grabbed behind it', async () => {
    const { deps, host, historyRepo } = buildDeps({
      releases: [{ title: 'Show.S01.1080p', downloadUrl: 'u1', indexerId: 1 }],
      isFullSeason: true,
    });
    host.on('acquisition.candidates', () => ({ items: packAndEpisode(), cursor: null }));

    await searchMissing(deps);

    assert.equal(historyRepo.insertCalls.length, 1);
    assert.equal(historyRepo.insertCalls[0]?.episodeId, null);
  });

  test('a pack still downloading from an earlier run covers its episodes', async () => {
    const { deps, host, historyRepo } = buildDeps({
      releases: [{ title: 'Show.S01E03.1080p', downloadUrl: 'u1', indexerId: 1 }],
    });
    host.on('acquisition.candidates', () => ({ items: [packAndEpisode()[1]!], cursor: null }));
    historyRepo.rows.push({
      id: 1,
      mediaId: 1,
      seasonId: SEASON.id,
      episodeId: null,
      status: 'grabbed',
      sourceTitle: 'Show.S01.1080p',
    } as never);

    await searchMissing(deps);

    // The pack's source title never matches an episode pattern, so without the season-pack
    // check this episode would be grabbed alongside the pack already in flight.
    assert.equal(historyRepo.insertCalls.length, 0);
  });
});

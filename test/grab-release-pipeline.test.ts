/**
 * Ported behaviour from `MovieDownloadService.grabMovie`/`grabUpgrade` and
 * `EpisodeDownloadService.grabEpisode` — collapsed in this port into one
 * `grabRelease` (see `release-pipeline.ts`'s header comment for why): the
 * manual-URL guard (blocklist + quality-allowed, not the full rejection set)
 * and the auto-pick guard (no eligible release, no download client, no
 * profile) both need to behave like the originals'.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { grabRelease, searchReleases, GrabError, type ReleasePipelineDeps, type AcquisitionTarget } from '../src/grab/release-pipeline';
import type { IndexerDriver } from '../src/seams/indexers';
import { FakeHistoryRepo, FakeDriver, FakeHost, FakeBlocklistRepo, makeClient, asHistoryRepo, asBlocklistRepo } from './grab-test-helpers';

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

function buildDeps(opts: { target: AcquisitionTarget | null; releases?: { title: string; downloadUrl: string; indexerId: number }[]; scored?: unknown[]; clients?: ReturnType<typeof makeClient>[] }) {
  const historyRepo = new FakeHistoryRepo();
  const driver = new FakeDriver();
  const host = new FakeHost();
  host.on('media.acquisitionContext', () => opts.target);
  host.on('events.publish', () => undefined);
  host.on('notifications.dispatch', () => undefined);
  const indexerRows = (opts.releases ?? []).length ? [{ id: 1, name: 'ix', implementation: 'torznab', settings: {}, enableRss: true, enableSearch: true, priority: 1, enabled: true, capsSearchFallback: false, capsMovieSearch: false, capsTvSearch: false, requestDelay: 2, createdAt: '', updatedAt: '' }] : [];
  host.on('releases.score', (p: unknown) => {
    const releases = (p as { releases: { id: string }[] }).releases;
    return releases.map((r, i) => opts.scored?.[i] ?? { id: r.id, qualityId: 5, rank: 30, allowed: true, customFormatScore: 0, blocklisted: false, languageId: null, languageAllowed: true, isFullSeason: false, sizeDeviation: 0, videoCodec: null, rejections: [] });
  });
  const deps: ReleasePipelineDeps = {
    host,
    indexer: fakeIndexerDriver(opts.releases ?? []),
    driver,
    indexersRepo: { listEnabled: async () => indexerRows as never },
    clientsRepo: { listEnabled: async () => opts.clients ?? [makeClient({ id: 1 })] },
    historyRepo: asHistoryRepo(historyRepo),
    blocklistRepo: asBlocklistRepo(new FakeBlocklistRepo()),
  };
  return { deps, historyRepo, driver, host };
}

describe('searchReleases', () => {
  test('returns [] when want is null — nothing to search for', async () => {
    const { deps } = buildDeps({ target: target({ want: null }), releases: [{ title: 'x', downloadUrl: 'u', indexerId: 1 }] });
    const result = await searchReleases(deps, 1);
    assert.deepEqual(result, []);
  });

  test('throws media_not_found when acquisitionContext resolves null', async () => {
    const { deps } = buildDeps({ target: null });
    await assert.rejects(() => searchReleases(deps, 999), (e: unknown) => e instanceof GrabError && e.messageKey === 'download.grab.errors.media_not_found');
  });
});

describe('grabRelease — manual URL', () => {
  test('rejects a blocklisted manual title without adding it to the client', async () => {
    const { deps, driver } = buildDeps({
      target: target({}),
      scored: [{ id: '0', qualityId: 5, rank: 30, allowed: true, customFormatScore: 0, blocklisted: true, languageId: null, languageAllowed: true, isFullSeason: false, sizeDeviation: 0, videoCodec: null, rejections: [] }],
    });
    await assert.rejects(
      () => grabRelease(deps, 1, undefined, undefined, { downloadUrl: 'magnet:?xt=urn:btih:aaa', sourceTitle: 'Bad.Release' }),
      (e: unknown) => e instanceof GrabError && e.messageKey === 'download.grab.errors.blocklisted',
    );
    assert.equal(driver.added.length, 0);
  });

  test('rejects a manual title whose quality is not allowed by the profile', async () => {
    const { deps, driver } = buildDeps({
      target: target({}),
      scored: [{ id: '0', qualityId: 5, rank: 30, allowed: false, customFormatScore: 0, blocklisted: false, languageId: null, languageAllowed: true, isFullSeason: false, sizeDeviation: 0, videoCodec: null, rejections: [] }],
    });
    await assert.rejects(
      () => grabRelease(deps, 1, undefined, undefined, { downloadUrl: 'magnet:?xt=urn:btih:aaa' }),
      (e: unknown) => e instanceof GrabError && e.messageKey === 'download.grab.errors.quality_not_allowed',
    );
    assert.equal(driver.added.length, 0);
  });

  test('grabs a manual URL that passes both guards, without rejecting an already-present hash', async () => {
    const { deps, driver, historyRepo } = buildDeps({ target: target({}) });
    await grabRelease(deps, 1, undefined, undefined, { downloadUrl: 'magnet:?xt=urn:btih:aaa', sourceTitle: 'Good.Release', indexerId: 7 });
    assert.equal(driver.added[0]?.rejectIfAlreadyPresent, undefined, 'interactive grabs never force rejectIfAlreadyPresent — matches the manual grabMovie/grabEpisode call sites');
    assert.equal(historyRepo.insertCalls[0]?.grabSource, 'manual');
    assert.equal(historyRepo.insertCalls[0]?.indexerId, 7);
  });
});

describe('grabRelease — auto-pick', () => {
  test('throws unprofiled when want is null', async () => {
    const { deps } = buildDeps({ target: target({ want: null }) });
    await assert.rejects(() => grabRelease(deps, 1), (e: unknown) => e instanceof GrabError && e.messageKey === 'download.grab.errors.unprofiled');
  });

  test('throws no_download_client when no configured client supports the driver', async () => {
    const { deps } = buildDeps({ target: target({}), clients: [makeClient({ id: 1, enabled: false })] });
    await assert.rejects(() => grabRelease(deps, 1), (e: unknown) => e instanceof GrabError && e.messageKey === 'download.grab.errors.no_download_client');
  });

  test('throws no_eligible_release when every scored candidate is rejected', async () => {
    const { deps } = buildDeps({
      target: target({}),
      releases: [{ title: 'Movie.2020.HDTV', downloadUrl: 'u1', indexerId: 1 }],
      scored: [{ id: '0', qualityId: 1, rank: 5, allowed: false, customFormatScore: 0, blocklisted: false, languageId: null, languageAllowed: true, isFullSeason: false, sizeDeviation: 0, videoCodec: null, rejections: [{ code: 'quality-not-allowed' }] }],
    });
    await assert.rejects(() => grabRelease(deps, 1), (e: unknown) => e instanceof GrabError && e.messageKey === 'download.grab.errors.no_eligible_release');
  });

  test('auto-picks the first eligible scored release and grabs it', async () => {
    const { deps, historyRepo, driver } = buildDeps({
      target: target({}),
      releases: [{ title: 'Movie.2020.1080p', downloadUrl: 'u1', indexerId: 1 }],
      scored: [{ id: '0', qualityId: 5, rank: 30, allowed: true, customFormatScore: 0, blocklisted: false, languageId: null, languageAllowed: true, isFullSeason: false, sizeDeviation: 0, videoCodec: null, rejections: [] }],
    });
    const result = await grabRelease(deps, 1);
    assert.equal(result.torrentHash, driver.nextHash);
    assert.equal(historyRepo.insertCalls[0]?.grabSource, 'auto');
    assert.equal(historyRepo.insertCalls[0]?.sourceTitle, 'Movie.2020.1080p');
  });

  test('a failing events.publish never fails the grab — notify-only, like notifications.dispatch', async () => {
    const { deps, host, historyRepo, driver } = buildDeps({
      target: target({}),
      releases: [{ title: 'Movie.2020.1080p', downloadUrl: 'u1', indexerId: 1 }],
      scored: [{ id: '0', qualityId: 5, rank: 30, allowed: true, customFormatScore: 0, blocklisted: false, languageId: null, languageAllowed: true, isFullSeason: false, sizeDeviation: 0, videoCodec: null, rejections: [] }],
    });
    host.on('events.publish', () => {
      throw new Error('core is down');
    });
    const result = await grabRelease(deps, 1);
    assert.equal(result.torrentHash, driver.nextHash);
    assert.equal(historyRepo.insertCalls.length, 1, 'the history row must be recorded regardless of the publish outcome');
  });
});

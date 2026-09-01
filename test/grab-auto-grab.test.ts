/**
 * Ported behaviour from `AutoGrabExecutorService.tryAutoGrab`
 * (`auto-grab-pipeline.service.ts`): skip on no profile/already-satisfied,
 * duplicate-grab suppression via `pendingCheck`, pick-and-grab, and a grab
 * failure being caught rather than thrown (a scheduler batch must not die on
 * one bad candidate).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tryAutoGrab } from '../src/grab/auto-grab';
import type { ReleasePipelineDeps, AcquisitionTarget } from '../src/grab/release-pipeline';
import { FakeHistoryRepo, FakeDriver, FakeHost, FakeBlocklistRepo, makeClient, asHistoryRepo, asBlocklistRepo } from './grab-test-helpers';
import type { RankedRelease } from '../src/grab/release-scoring';

function target(over: Partial<AcquisitionTarget>): AcquisitionTarget {
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
    want: { decision: 'missing', allowedQualityIds: [], allowedLanguageIds: [], minResolution: 0, resolutionUpgradeOnly: false },
    expectedTitles: ['Movie'],
    searchTitle: 'Movie',
    ...over,
  };
}

function release(over: Partial<RankedRelease>): RankedRelease {
  return {
    title: 'Movie.2020.1080p.WEBDL',
    downloadUrl: 'magnet:?xt=urn:btih:aaa',
    indexerId: 1,
    indexerName: 'ix',
    size: 1000,
    seeders: 10,
    leechers: 1,
    publishDate: new Date().toISOString(),
    freeleech: false,
    downloadVolumeFactor: 1,
    id: '0',
    qualityId: 5,
    qualityName: '1080p',
    rank: 30,
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

function buildDeps() {
  const historyRepo = new FakeHistoryRepo();
  const driver = new FakeDriver();
  const host = new FakeHost().on('events.publish', () => undefined).on('notifications.dispatch', () => undefined);
  const deps: ReleasePipelineDeps = {
    host,
    indexer: {} as ReleasePipelineDeps['indexer'],
    driver,
    indexersRepo: { listEnabled: async () => [] },
    clientsRepo: { listEnabled: async () => [] },
    historyRepo: asHistoryRepo(historyRepo),
    blocklistRepo: asBlocklistRepo(new FakeBlocklistRepo()),
  };
  return { deps, historyRepo, driver, host };
}

describe('tryAutoGrab', () => {
  test('skips when want is null (unprofiled) without searching', async () => {
    const { deps } = buildDeps();
    let searched = false;
    const ok = await tryAutoGrab(deps, target({ want: null }), makeClient(), async () => {
      searched = true;
      return [];
    });
    assert.equal(ok, false);
    assert.equal(searched, false);
  });

  test('skips a skip-decision target (already satisfies its profile) without searching — never grabbed unattended', async () => {
    const { deps } = buildDeps();
    let searched = false;
    const skipWant = { decision: 'skip' as const, allowedQualityIds: [], allowedLanguageIds: [], minResolution: 0, resolutionUpgradeOnly: false };
    const ok = await tryAutoGrab(deps, target({ want: skipWant }), makeClient(), async () => {
      searched = true;
      return [release({})];
    });
    assert.equal(ok, false);
    assert.equal(searched, false);
  });

  test('duplicate-grab suppression: a pending grab skips before any search', async () => {
    const { deps } = buildDeps();
    let searched = false;
    const ok = await tryAutoGrab(
      deps,
      target({}),
      makeClient(),
      async () => {
        searched = true;
        return [release({})];
      },
      async () => true, // a grab is already pending
    );
    assert.equal(ok, false);
    assert.equal(searched, false);
  });

  test('picks the first eligible release and grabs it, recording the history row', async () => {
    const { deps, historyRepo, driver } = buildDeps();
    const ok = await tryAutoGrab(deps, target({}), makeClient({ id: 3 }), async () => [release({ rank: 40 })]);
    assert.equal(ok, true);
    assert.equal(historyRepo.insertCalls.length, 1);
    assert.equal(historyRepo.insertCalls[0]?.grabSource, 'auto');
    // Scheduler/RSS grabs reject a hash the client already holds — unlike the interactive path.
    assert.equal(driver.added[0]?.rejectIfAlreadyPresent, true);
  });

  test('no eligible release (every candidate rejected) skips without grabbing', async () => {
    const { deps, historyRepo } = buildDeps();
    const ok = await tryAutoGrab(deps, target({}), makeClient(), async () => [release({ rejections: [{ code: 'quality-not-allowed' }] })]);
    assert.equal(ok, false);
    assert.equal(historyRepo.insertCalls.length, 0);
  });

  test('a grab failure is caught and returns false — never throws out of a scheduler batch', async () => {
    const { deps, driver } = buildDeps();
    driver.addShouldReject = true;
    const ok = await tryAutoGrab(deps, target({}), makeClient(), async () => [release({})]);
    assert.equal(ok, false);
  });
});

/**
 * The streamed half of an interactive search. Two things have to hold or the feature is
 * either a leak or a lie: every emission is addressed to the account that asked (core's
 * media-scoped audience resolves to a title's *requesters*, so a wrong audience pushes
 * release titles at someone who never searched), and each emitted list is the whole
 * accumulated set re-ranked — core's relevance sort is non-transitive, so a merge of
 * per-indexer batches would disagree with the response the viewer ends up with.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { searchReleases, type ReleasePipelineDeps, type AcquisitionTarget } from '../src/grab/release-pipeline';
import type { IndexerDriver } from '../src/seams/indexers';
import type { IndexerRow } from '../src/db/rows';
import type { IndexerRelease } from '../src/indexers/types';
import { createSearchStreamer } from '../src/grab/search-stream';
import { FakeHistoryRepo, FakeDriver, FakeHost, FakeBlocklistRepo, makeClient, asHistoryRepo, asBlocklistRepo } from './grab-test-helpers';

function target(): AcquisitionTarget {
  return {
    mediaId: 7,
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
  } as AcquisitionTarget;
}

function row(id: number, name: string): IndexerRow {
  return { id, name, implementation: 'torznab', settings: {}, enableRss: true, enableSearch: true, priority: id, enabled: true, capsSearchFallback: false, capsMovieSearch: false, capsTvSearch: false, requestDelay: 0, createdAt: '', updatedAt: '' } as unknown as IndexerRow;
}

function release(indexer: IndexerRow, n: number): IndexerRelease {
  return { title: `${indexer.name}.${n}.1080p`, downloadUrl: `${indexer.name}-${n}`, indexerId: indexer.id, indexerName: indexer.name, size: 1000, seeders: 10, leechers: 1, publishDate: new Date(0).toISOString(), freeleech: false, downloadVolumeFactor: 1 };
}

interface Emitted {
  type: string;
  searchId: string;
  indexers: { id: number; name: string; state: string }[];
  releases?: { sourceName: string; title: string }[];
  audience: unknown;
}

/** `rows` are queried; `cooling` are dropped by the readiness filter. Each queried indexer
 *  resolves only when its gate is released, so arrival order is the test's to choose. */
function harness(opts: { rows: IndexerRow[]; cooling?: IndexerRow[]; perIndexer?: number }) {
  const perIndexer = opts.perIndexer ?? 2;
  const cooling = opts.cooling ?? [];
  const gates = new Map<number, () => void>();
  const pending = new Map<number, Promise<IndexerRelease[]>>();

  for (const ix of opts.rows) {
    pending.set(
      ix.id,
      new Promise<IndexerRelease[]>((resolve) => {
        gates.set(ix.id, () => resolve(Array.from({ length: perIndexer }, (_, n) => release(ix, n))));
      }),
    );
  }

  const coolingIds = new Set(cooling.map((ix) => ix.id));
  const indexer: IndexerDriver = {
    searchMovie: (ix: IndexerRow) => pending.get(ix.id)!,
    searchSeries: (ix: IndexerRow) => pending.get(ix.id)!,
    searchSeasonPack: (ix: IndexerRow) => pending.get(ix.id)!,
    rssSearch: async () => [],
    filterReadyIndexers: (ixs: IndexerRow[]) => ixs.filter((ix) => !coolingIds.has(ix.id)),
    refreshCaps: async () => undefined,
    testConnection: async () => ({ ok: true, messageKey: 'download.indexers.test.ok' as const }),
  } as unknown as IndexerDriver;

  const emitted: Emitted[] = [];
  const host = new FakeHost();
  host.on('media.acquisitionContext', () => target());
  host.on('config.get', () => ({}));
  host.on('releases.score', (p: unknown) => {
    const releases = (p as { releases: { id: string }[] }).releases;
    // Reverse of the order sent, so a caller echoing its input rather than core's answer
    // would be visible in the assertions.
    return releases.map((r) => ({ id: r.id, qualityId: 5, rank: 30, allowed: true, customFormatScore: 0, blocklisted: false, languageId: null, languageName: 'x', languageAllowed: true, isFullSeason: false, sizeDeviation: 0, videoCodec: null, rejections: [] })).reverse();
  });
  host.on('events.emitOwn', (p: unknown) => {
    const call = p as { type: string; payload: Record<string, unknown>; audience: unknown };
    emitted.push({
      type: call.type,
      searchId: call.payload['searchId'] as string,
      indexers: call.payload['indexers'] as Emitted['indexers'],
      releases: call.payload['releases'] as Emitted['releases'],
      audience: call.audience,
    });
    return undefined;
  });

  const deps: ReleasePipelineDeps = {
    host,
    indexer,
    driver: new FakeDriver(),
    indexersRepo: { listEnabled: async () => [...opts.rows, ...cooling] as never },
    clientsRepo: { listEnabled: async () => [makeClient({ id: 1 })] },
    historyRepo: asHistoryRepo(new FakeHistoryRepo()),
    blocklistRepo: asBlocklistRepo(new FakeBlocklistRepo()),
  };

  const scoreCalls = () => host.calls.filter((c) => c.method === 'releases.score').length;
  /** Lets every queued continuation run — the emission path awaits the blocklist lookups
   *  and the score call, so a fixed number of microtask turns is not enough. */
  const settle = () => new Promise((r) => setImmediate(r));
  const answer = async (ix: IndexerRow) => {
    gates.get(ix.id)!();
    await settle();
  };

  return { deps, emitted, scoreCalls, answer, settle, host };
}

const A = row(1, 'alpha');
const B = row(2, 'bravo');
const C = row(3, 'charlie');

describe('streamed interactive search', () => {
  test('VERDICT: every emission is addressed to the searching account, never a media audience or a broadcast', async () => {
    const h = harness({ rows: [A, B] });
    const done = searchReleases(h.deps, 7, undefined, undefined, undefined, { userId: 42, searchId: 's1' });
    await h.answer(A);
    await h.answer(B);
    await done;

    assert.ok(h.emitted.length > 0, 'nothing was emitted at all');
    for (const e of h.emitted) {
      assert.deepEqual(e.audience, { userId: 42 }, `${e.type} escaped its audience`);
      assert.equal(e.searchId, 's1');
    }
  });

  test('the roster goes out before any indexer answers, with cooling ones marked skipped', async () => {
    const h = harness({ rows: [A, B], cooling: [C] });
    const done = searchReleases(h.deps, 7, undefined, undefined, undefined, { userId: 1, searchId: 's' });
    await h.settle();

    const first = h.emitted[0];
    assert.equal(first?.type, 'search.state');
    assert.equal(first?.releases, undefined, 'the opening roster carries no list to replace');
    assert.deepEqual(
      first?.indexers.map((i) => [i.name, i.state]),
      [
        ['alpha', 'pending'],
        ['bravo', 'pending'],
        ['charlie', 'skipped'],
      ],
    );

    await h.answer(A);
    await h.answer(B);
    await done;
  });

  test('VERDICT: each partial carries the whole accumulated set re-ranked, not just the new batch', async () => {
    const h = harness({ rows: [A, B], perIndexer: 2 });
    const done = searchReleases(h.deps, 7, undefined, undefined, undefined, { userId: 1, searchId: 's' });

    await h.answer(A);
    const afterA = h.emitted.filter((e) => e.releases).at(-1);
    assert.deepEqual(afterA?.releases?.map((r) => r.sourceName), ['alpha', 'alpha']);

    await h.answer(B);
    const afterB = h.emitted.filter((e) => e.releases).at(-1);
    assert.equal(afterB?.releases?.length, 4, 'the second partial must re-rank alpha together with bravo');
    // The fake scorer reverses what it is sent, so the emitted order proves the list came
    // back through `releases.score` rather than being the plugin's own accumulation order.
    assert.deepEqual(afterB?.releases?.map((r) => r.title), [
      'bravo.1.1080p',
      'bravo.0.1080p',
      'alpha.1.1080p',
      'alpha.0.1080p',
    ]);

    await done;
  });

  test('a re-rank happens once per indexer that adds results, never twice for the same one', async () => {
    const h = harness({ rows: [A, B, C] });
    const done = searchReleases(h.deps, 7, undefined, undefined, undefined, { userId: 1, searchId: 's' });
    await h.settle();

    h.answer(A);
    h.answer(B);
    h.answer(C);
    await h.settle();
    await done;

    // Three contributing indexers plus the final answer. Coalescing can only lower the
    // streamed count; what must never happen is a pass per emission.
    assert.ok(h.scoreCalls() <= 4, `${h.scoreCalls()} score calls for 3 indexers — one is being re-ranked twice`);
    assert.ok(h.scoreCalls() >= 2, 'the stream ranked nothing');
  });

  test('an indexer that returns nothing updates its tab without spending a re-rank', async () => {
    const h = harness({ rows: [A], perIndexer: 0 });
    const done = searchReleases(h.deps, 7, undefined, undefined, undefined, { userId: 1, searchId: 's' });
    await h.answer(A);
    await done;

    assert.equal(h.scoreCalls(), 0, 'an empty accumulated set is nothing to score');
    assert.deepEqual(h.emitted.at(-1)?.indexers.map((i) => i.state), ['done']);
    assert.equal(h.emitted.at(-1)?.releases, undefined);
  });

  test('no stream target means no emission — a cron SearchMissing must push nothing', async () => {
    const h = harness({ rows: [A] });
    const done = searchReleases(h.deps, 7);
    await h.answer(A);
    await done;
    assert.deepEqual(h.emitted, []);
  });

  test('VERDICT: an emit that throws costs the live view, never the search', async () => {
    const h = harness({ rows: [A] });
    h.host.on('events.emitOwn', () => {
      throw new Error('SSE gone');
    });
    const done = searchReleases(h.deps, 7, undefined, undefined, undefined, { userId: 1, searchId: 's' });
    await h.answer(A);
    const result = await done;
    assert.equal(result.length, 2, 'the HTTP answer must survive a dead event stream');
  });
});

/**
 * The coalescing lives in `createSearchStreamer` and is what keeps the query count linear
 * in indexers rather than in emissions. Driven directly here: at the pipeline level the
 * microtask interleaving decides whether two arrivals actually overlap, so an assertion
 * there would pin the scheduler instead of the behaviour.
 */
describe('createSearchStreamer coalescing', () => {
  function streamerHarness() {
    const emitted: { type: string }[] = [];
    let ranks = 0;
    let release: (() => void) | null = null;
    const host = new FakeHost().on('events.emitOwn', (p: unknown) => {
      emitted.push({ type: (p as { type: string }).type });
      return undefined;
    });
    const streamer = createSearchStreamer({
      host,
      target: { userId: 1, searchId: 's' },
      rank: () => {
        ranks++;
        return new Promise<unknown[]>((resolve) => {
          release = () => resolve([]);
        });
      },
    });
    return { streamer, emitted, ranks: () => ranks, finishRank: async () => { release?.(); await new Promise((r) => setImmediate(r)); } };
  }

  const withReleases = (n: number) => ({ releases: Array.from({ length: n }, () => ({}) as never) });

  test('VERDICT: arrivals during an in-flight rank share the single pass that follows', async () => {
    const h = streamerHarness();
    h.streamer.settled(A, withReleases(2));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.ranks(), 1, 'the first arrival ranks immediately');

    // Two more land while that rank is still out.
    h.streamer.settled(B, withReleases(2));
    h.streamer.settled(C, withReleases(2));
    assert.equal(h.ranks(), 1, 'neither started a rank of its own');

    await h.finishRank();
    assert.equal(h.ranks(), 2, 'both collapsed into one trailing pass, not two');
  });

  test('a rank that throws drops the emission and leaves the streamer usable', async () => {
    const host = new FakeHost().on('events.emitOwn', () => undefined);
    let ranks = 0;
    const streamer = createSearchStreamer({
      host,
      target: { userId: 1, searchId: 's' },
      rank: async () => {
        ranks++;
        if (ranks === 1) throw new Error('score unavailable');
        return [];
      },
    });
    streamer.settled(A, withReleases(1));
    await new Promise((r) => setImmediate(r));
    streamer.settled(B, withReleases(1));
    await new Promise((r) => setImmediate(r));
    assert.equal(ranks, 2, 'a failed rank must not wedge the streamer shut');
  });
});

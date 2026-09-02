/**
 * The fan-out's budget: one indexer left hanging must not hold the whole search, which is
 * what pushed an interactive search past core's deadline for the route and threw away the
 * results every other indexer had already returned.
 */
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { searchMovieAcrossIndexers } from '../src/grab/release-search';
import type { IndexerDriver } from '../src/seams/indexers';
import type { IndexerRelease } from '../src/indexers/types';
import type { IndexerRow } from '../src/db/rows';

function row(id: number, name: string): IndexerRow {
  return { id, name } as IndexerRow;
}

function release(title: string): IndexerRelease {
  return { title } as IndexerRelease;
}

/** `fast` answers, `hung` never settles, `angry` rejects. */
function driver(): IndexerDriver {
  return {
    filterReadyIndexers: (indexers: IndexerRow[]) => indexers,
    searchMovie: (ix: IndexerRow) => {
      if (ix.name === 'hung') return new Promise<IndexerRelease[]>(() => {});
      if (ix.name === 'angry') return Promise.reject(new Error('fetch failed'));
      return Promise.resolve([release(`${ix.name}-1`)]);
    },
  } as unknown as IndexerDriver;
}

describe('searchMovieAcrossIndexers', () => {
  test('VERDICT: a hung indexer is dropped once its budget lapses, the others still count', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pending = searchMovieAcrossIndexers(
        driver(),
        [row(1, 'fast'), row(2, 'hung'), row(3, 'other')],
        'auto',
        'Some Title 2024',
        {},
      );
      // Let the ones that answer settle, as they do long before the budget in production.
      await new Promise((resolve) => setImmediate(resolve));
      // Nothing waits on the hung one past its budget.
      mock.timers.tick(120_000);
      const releases = await pending;
      assert.deepEqual(
        releases.map((r) => r.title),
        ['fast-1', 'other-1'],
      );
    } finally {
      mock.timers.reset();
    }
  });

  // The budget is not just "some ceiling": it has to clear a reverse proxy's default 60s read
  // timeout, or the 504 discards every indexer that had already answered. Ticking exactly the
  // budget is what pins that — at the old 120s this resolves to nothing.
  test('VERDICT: the fan-out gives up well inside a reverse proxy timeout', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pending = searchMovieAcrossIndexers(
        driver(),
        [row(1, 'fast'), row(2, 'hung')],
        'auto',
        'Some Title 2024',
        {},
      );
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(30_000);
      const releases = await pending;
      assert.deepEqual(
        releases.map((r) => r.title),
        ['fast-1'],
      );
    } finally {
      mock.timers.reset();
    }
  });

  test('a rejecting indexer costs nothing but its own results', async () => {
    const releases = await searchMovieAcrossIndexers(
      driver(),
      [row(1, 'fast'), row(2, 'angry')],
      'auto',
      'Some Title 2024',
      {},
    );
    assert.deepEqual(
      releases.map((r) => r.title),
      ['fast-1'],
    );
  });

  test('every indexer in cooldown searches nothing rather than sleeping it out', async () => {
    const cooling = { ...driver(), filterReadyIndexers: () => [] } as unknown as IndexerDriver;
    assert.deepEqual(await searchMovieAcrossIndexers(cooling, [row(1, 'fast')], 'auto', 'q', {}), []);
  });
});

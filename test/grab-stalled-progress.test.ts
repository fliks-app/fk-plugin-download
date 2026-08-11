/** Ported assertions from `stalled-progress.util.spec.ts` (Fliks source),
 *  adapted to plain `number` byte counters (see `src/download-clients/stalled-progress.ts`'s
 *  header comment for why). */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isNoProgress, countStalledStrikes, STALL_PROGRESS_TOLERANCE_BYTES } from '../src/download-clients/stalled-progress';

const TOLERANCE = STALL_PROGRESS_TOLERANCE_BYTES;
const samples = (...bytesNewestFirst: number[]) => bytesNewestFirst.map((b) => ({ downloadedBytes: b }));

describe('isNoProgress', () => {
  test('treats equal byte counts as no progress', () => {
    assert.equal(isNoProgress(1000, 1000), true);
  });

  test('treats a sub-tolerance trickle as no progress', () => {
    assert.equal(isNoProgress(1000, 1000 + TOLERANCE - 1), true);
  });

  test('treats exactly one tolerance worth of bytes as progress', () => {
    assert.equal(isNoProgress(1000, 1000 + TOLERANCE), false);
  });

  test('treats a counter reset (negative delta) as progress', () => {
    assert.equal(isNoProgress(5 * TOLERANCE, 0), false);
  });
});

describe('countStalledStrikes', () => {
  test('returns 0 with no snapshots', () => {
    assert.equal(countStalledStrikes([]), 0);
  });

  test('counts a lone snapshot as 1 strike', () => {
    assert.equal(countStalledStrikes(samples(1000)), 1);
  });

  test('counts N flat snapshots as N strikes', () => {
    assert.equal(countStalledStrikes(samples(1000, 1000, 1000, 1000)), 4);
  });

  test('stops the run at the first progressing step', () => {
    assert.equal(countStalledStrikes(samples(5 * TOLERANCE, 5 * TOLERANCE, 5 * TOLERANCE, 3 * TOLERANCE)), 3);
  });

  test('returns 1 when the newest step shows progress', () => {
    assert.equal(countStalledStrikes(samples(5 * TOLERANCE, 3 * TOLERANCE, 3 * TOLERANCE)), 1);
  });

  test('breaks the run on a counter reset', () => {
    assert.equal(countStalledStrikes(samples(0, 5 * TOLERANCE, 5 * TOLERANCE)), 1);
  });

  test('tolerates a trickle inside the run', () => {
    assert.equal(countStalledStrikes(samples(1000 + 2 * (TOLERANCE - 1), 1000 + (TOLERANCE - 1), 1000)), 3);
  });
});

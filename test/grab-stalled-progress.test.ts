/** Ported assertions from `stalled-progress.util.spec.ts` (Fliks source),
 *  adapted to plain `number` byte counters (see `src/download-clients/stalled-progress.ts`'s
 *  header comment for why). */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isNoProgress, countStalledStrikes } from '../src/download-clients/stalled-progress';

const KIB = 1024;
const MIN = 8 * KIB; // bytes per second
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString();
const sample = (downloadedBytes: number, minutes: number) => ({ downloadedBytes, checkedAt: at(minutes) });
/** Snapshots an hour apart, newest first. */
const samples = (...bytesNewestFirst: number[]) =>
  bytesNewestFirst.map((b, i) => sample(b, (bytesNewestFirst.length - 1 - i) * 60));
const HOUR_AT_MIN = MIN * 3600;

describe('isNoProgress', () => {
  test('treats equal byte counts as no progress', () => {
    assert.equal(isNoProgress(sample(1000, 0), sample(1000, 60), MIN), true);
  });

  test('treats a step averaging under the minimum speed as no progress', () => {
    assert.equal(isNoProgress(sample(0, 0), sample(HOUR_AT_MIN - 1, 60), MIN), true);
  });

  test('treats a step at the minimum speed as progress', () => {
    assert.equal(isNoProgress(sample(0, 0), sample(HOUR_AT_MIN, 60), MIN), false);
  });

  test('measures over the real gap, so the same bytes pass over a shorter one', () => {
    assert.equal(isNoProgress(sample(0, 0), sample(HOUR_AT_MIN / 2, 60), MIN), true);
    assert.equal(isNoProgress(sample(0, 0), sample(HOUR_AT_MIN / 2, 30), MIN), false);
  });

  test('catches a steady 5 KiB/s crawl at any interval', () => {
    for (const minutes of [5, 60, 1440]) {
      assert.equal(isNoProgress(sample(0, 0), sample(5 * KIB * minutes * 60, minutes), MIN), true);
    }
  });

  test('treats a counter reset (negative delta) as progress', () => {
    assert.equal(isNoProgress(sample(5 * HOUR_AT_MIN, 0), sample(0, 60), MIN), false);
  });
});

describe('countStalledStrikes', () => {
  test('returns 0 with no snapshots', () => {
    assert.equal(countStalledStrikes([], MIN), 0);
  });

  test('counts a lone snapshot as 1 strike', () => {
    assert.equal(countStalledStrikes(samples(1000), MIN), 1);
  });

  test('counts N flat snapshots as N strikes', () => {
    assert.equal(countStalledStrikes(samples(1000, 1000, 1000, 1000), MIN), 4);
  });

  test('stops the run at the first progressing step', () => {
    const h = HOUR_AT_MIN;
    assert.equal(countStalledStrikes(samples(5 * h, 5 * h, 5 * h, 3 * h), MIN), 3);
  });

  test('returns 1 when the newest step shows progress', () => {
    const h = HOUR_AT_MIN;
    assert.equal(countStalledStrikes(samples(5 * h, 3 * h, 3 * h), MIN), 1);
  });

  test('breaks the run on a counter reset', () => {
    const h = HOUR_AT_MIN;
    assert.equal(countStalledStrikes(samples(0, 5 * h, 5 * h), MIN), 1);
  });

  test('tolerates a trickle inside the run', () => {
    const t = HOUR_AT_MIN - 1;
    assert.equal(countStalledStrikes(samples(1000 + 2 * t, 1000 + t, 1000), MIN), 3);
  });
});

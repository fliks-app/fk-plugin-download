import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrabHistoryRow, toCoverageColumns } from '../src/grab/grab-history';

const base = { mediaId: 1, downloadClientId: 1, sourceTitle: 'x', torrentHash: 'h', quality: '1080p', grabSource: 'auto' as const };

test('toCoverageColumns flattens ranges, keeps season 0 and episode 0', () => {
  assert.deepEqual(toCoverageColumns({ seasons: { from: 0, to: 0 }, episodes: { from: 0, to: 2 }, completeSeries: false }), {
    coverSeasonFrom: 0,
    coverSeasonTo: 0,
    coverEpisodeFrom: 0,
    coverEpisodeTo: 2,
    coverCompleteSeries: false,
  });
});

test('toCoverageColumns: complete series is known with no ranges', () => {
  const c = toCoverageColumns({ seasons: null, episodes: null, completeSeries: true });
  assert.deepEqual([c.coverSeasonFrom, c.coverEpisodeFrom, c.coverCompleteSeries], [null, null, true]);
});

test('toCoverageColumns: absent or unparseable coverage is unknown', () => {
  for (const c of [undefined, null, { seasons: null, episodes: null, completeSeries: false }]) {
    assert.equal(toCoverageColumns(c).coverCompleteSeries, null);
  }
});

test('buildGrabHistoryRow carries the coverage into the insert shape', () => {
  const row = buildGrabHistoryRow({ ...base, coverage: { seasons: { from: 1, to: 4 }, episodes: null, completeSeries: false } });
  assert.equal(row.coverage?.coverSeasonTo, 4);
  assert.equal(buildGrabHistoryRow(base).coverage?.coverCompleteSeries, null);
});

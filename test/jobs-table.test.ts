/** Proves `createJobHandlers`'s keys match `manifest.jobs[]` by comparison, not by eye —
 *  a mismatch here means core's `job` dispatch calls into nothing for that name. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobHandlers } from '../src/seams/jobs';
import { JOBS } from '../scripts/manifest-template';

test('job handler table keys are exactly the manifest jobs[] names', () => {
  const calls: string[] = [];
  const handlers = createJobHandlers({
    grabPipeline: {
      searchMissing: async () => void calls.push('searchMissing'),
      rssSync: async () => void calls.push('rssSync'),
    },
    completionPoller: {
      poll: async () => void calls.push('poll'),
      cleanStalled: async () => void calls.push('cleanStalled'),
      cleanSeeded: async () => void calls.push('cleanSeeded'),
    },
  });

  assert.deepEqual(
    Object.keys(handlers).sort(),
    JOBS.map((j) => j.name).sort(),
    'every manifest job name must have exactly one handler, and vice versa',
  );
});

test('each handler calls through to its own pipeline/poller method, not a neighbour\'s', async () => {
  const calls: string[] = [];
  const handlers = createJobHandlers({
    grabPipeline: {
      searchMissing: async () => void calls.push('searchMissing'),
      rssSync: async () => void calls.push('rssSync'),
    },
    completionPoller: {
      poll: async () => void calls.push('poll'),
      cleanStalled: async () => void calls.push('cleanStalled'),
      cleanSeeded: async () => void calls.push('cleanSeeded'),
    },
  });

  await handlers['SearchMissing']!('job-1');
  await handlers['RssSync']!('job-2');
  await handlers['ImportCompleted']!('job-3');
  await handlers['CleanStalled']!('job-4');
  await handlers['CleanSeeded']!('job-5');

  assert.deepEqual(calls, ['searchMissing', 'rssSync', 'poll', 'cleanStalled', 'cleanSeeded']);
});

test('SearchMissing forwards a mediaIds array from args, and ignores a malformed one', async () => {
  const seen: (number[] | undefined)[] = [];
  const handlers = createJobHandlers({
    grabPipeline: { searchMissing: async (ids) => void seen.push(ids), rssSync: async () => {} },
    completionPoller: { poll: async () => {}, cleanStalled: async () => {}, cleanSeeded: async () => {} },
  });

  await handlers['SearchMissing']!('job-1', { mediaIds: [1, 2, 3] });
  await handlers['SearchMissing']!('job-2', { mediaIds: ['not-a-number'] });
  await handlers['SearchMissing']!('job-3', undefined);

  assert.deepEqual(seen, [[1, 2, 3], undefined, undefined]);
});

/**
 * The missing link: core states `media.acquisition.requested` on every approval, and the
 * plugin's note handler used to log it and drop it — so an approved request waited for the
 * next six-hourly SearchMissing instead of being searched at once.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACQUISITION_REQUESTED,
  AUTO_GRAB_ON_APPROVAL_KEY,
  createAcquisitionRequestedHandler,
} from '../src/grab/on-acquisition-requested';
import type { HostCaller } from '../src/grab/types';

function makeHandler(opts: { setting?: string; onSearch?: (ids: number[]) => Promise<void> } = {}) {
  const searched: number[][] = [];
  const host = {
    call: async (method: string) => {
      assert.equal(method, 'config.get');
      return opts.setting === undefined ? {} : { [AUTO_GRAB_ON_APPROVAL_KEY]: opts.setting };
    },
  } as unknown as HostCaller;
  const searchMissing = async (mediaIds: number[]) => {
    searched.push(mediaIds);
    if (opts.onSearch) await opts.onSearch(mediaIds);
  };
  return { handler: createAcquisitionRequestedHandler({ host, searchMissing }), searched };
}

/** The handler fires its work without awaiting: let its microtasks drain. */
const settle = () => new Promise((r) => setImmediate(r));

describe('createAcquisitionRequestedHandler', () => {
  test('VERDICT: searches exactly the media core named, instead of waiting for the next tick', async () => {
    const { handler, searched } = makeHandler();
    handler(ACQUISITION_REQUESTED, { mediaIds: [945], reason: 'request-approved' });
    await settle();
    assert.deepEqual(searched, [[945]]);
  });

  test('an unset setting counts as enabled, matching the manifest default', async () => {
    const { handler, searched } = makeHandler({ setting: '' });
    handler(ACQUISITION_REQUESTED, { mediaIds: [1] });
    await settle();
    assert.deepEqual(searched, [[1]]);
  });

  test('VERDICT: the plugin\'s own toggle, not core\'s, decides whether to act', async () => {
    const { handler, searched } = makeHandler({ setting: 'false' });
    handler(ACQUISITION_REQUESTED, { mediaIds: [1] });
    await settle();
    assert.deepEqual(searched, []);
  });

  test('ignores every other event name', async () => {
    const { handler, searched } = makeHandler();
    for (const name of ['request.approved', 'media.imported', 'settings.changed']) {
      handler(name, { mediaIds: [1] });
    }
    await settle();
    assert.deepEqual(searched, []);
  });

  test('ignores a payload carrying no usable id', async () => {
    const { handler, searched } = makeHandler();
    for (const payload of [{}, { mediaIds: [] }, { mediaIds: 'nope' }, { mediaIds: [null, 'x', 1.5] }, null]) {
      handler(ACQUISITION_REQUESTED, payload);
    }
    await settle();
    assert.deepEqual(searched, []);
  });

  test('VERDICT: a burst of approvals for the same media does not queue duplicate passes', async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => (release = r));
    const { handler, searched } = makeHandler({ onSearch: () => blocked });

    handler(ACQUISITION_REQUESTED, { mediaIds: [7] });
    await settle();
    // Still searching #7: a second event for it must not start another pass...
    handler(ACQUISITION_REQUESTED, { mediaIds: [7] });
    // ...while a different media is not held back by it.
    handler(ACQUISITION_REQUESTED, { mediaIds: [7, 8] });
    await settle();
    assert.deepEqual(searched, [[7], [8]]);

    release();
    await settle();
    // Once it finishes, #7 is searchable again.
    handler(ACQUISITION_REQUESTED, { mediaIds: [7] });
    await settle();
    assert.deepEqual(searched, [[7], [8], [7]]);
  });

  test('deduplicates ids inside one payload', async () => {
    const { handler, searched } = makeHandler();
    handler(ACQUISITION_REQUESTED, { mediaIds: [3, 3, 4] });
    await settle();
    assert.deepEqual(searched, [[3, 4]]);
  });

  test('a failing search is reported, never thrown into the note dispatcher', async () => {
    const { handler, searched } = makeHandler({ onSearch: () => Promise.reject(new Error('no client')) });
    handler(ACQUISITION_REQUESTED, { mediaIds: [5] });
    await settle();
    assert.deepEqual(searched, [[5]]);
    // The id is released again, so a retry is possible rather than blocked for the process's life.
    handler(ACQUISITION_REQUESTED, { mediaIds: [5] });
    await settle();
    assert.equal(searched.length, 2);
  });
});

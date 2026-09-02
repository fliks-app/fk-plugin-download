import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatesFor, isUseFor, useForOf, USE_FOR_VALUES } from '../src/indexers/use-for';

test('the projection round-trips every offered choice', () => {
  for (const value of USE_FOR_VALUES) {
    assert.equal(useForOf(gatesFor(value)), value, value);
  }
});

test('each choice gates exactly the path it names', () => {
  assert.deepEqual(gatesFor('both'), { enableRss: true, enableSearch: true });
  assert.deepEqual(gatesFor('search'), { enableRss: false, enableSearch: true });
  assert.deepEqual(gatesFor('rss'), { enableRss: true, enableSearch: false });
});

test('VERDICT: a row with both gates off reads back as both, since "neither" is what enabled:false says', () => {
  // Only an API caller could have written it, and an indexer answering nothing while claiming to
  // be enabled is a silent no-op rather than a state worth preserving.
  assert.equal(useForOf({ enableRss: false, enableSearch: false }), 'both');
});

test('isUseFor refuses anything outside the three choices', () => {
  assert.equal(isUseFor('both'), true);
  assert.equal(isUseFor('BOTH'), false);
  assert.equal(isUseFor('all'), false);
  assert.equal(isUseFor(undefined), false);
  assert.equal(isUseFor(1), false);
});

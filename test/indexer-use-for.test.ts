import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatesFor, isUseFor, isUseForList, useForOf, USE_FOR_VALUES } from '../src/indexers/use-for';

function allSubsets<T>(values: readonly T[]): T[][] {
  if (!values.length) return [[]];
  const [head, ...rest] = values;
  const withoutHead = allSubsets(rest);
  return [...withoutHead, ...withoutHead.map((s) => [head as T, ...s])];
}

test('the projection round-trips every non-empty subset, in declared order', () => {
  for (const subset of allSubsets(USE_FOR_VALUES)) {
    if (!subset.length) continue;
    const ordered = USE_FOR_VALUES.filter((v) => subset.includes(v));
    assert.deepEqual(useForOf(gatesFor(subset)), ordered, subset.join(','));
  }
});

test('each single usage gates exactly the path it names', () => {
  assert.deepEqual(gatesFor(['rss']), { enableRss: true, enableSearch: false, enableInteractiveSearch: false });
  assert.deepEqual(gatesFor(['auto']), { enableRss: false, enableSearch: true, enableInteractiveSearch: false });
  assert.deepEqual(gatesFor(['manual']), { enableRss: false, enableSearch: false, enableInteractiveSearch: true });
});

test('a row with all three gates off reads back as an empty set', () => {
  assert.deepEqual(useForOf({ enableRss: false, enableSearch: false, enableInteractiveSearch: false }), []);
});

test('isUseFor refuses anything outside the three values', () => {
  assert.equal(isUseFor('rss'), true);
  assert.equal(isUseFor('RSS'), false);
  assert.equal(isUseFor('both'), false);
  assert.equal(isUseFor(undefined), false);
  assert.equal(isUseFor(1), false);
});

test('isUseForList refuses an empty array and any array with an unknown entry', () => {
  assert.equal(isUseForList(['rss', 'auto', 'manual']), true);
  assert.equal(isUseForList(['rss']), true);
  assert.equal(isUseForList([]), false, 'empty is refused, never silently coerced');
  assert.equal(isUseForList(['rss', 'everything']), false);
  assert.equal(isUseForList('rss'), false, 'a bare string is not a list');
  assert.equal(isUseForList(undefined), false);
});

/**
 * The budget is the only knob bounding a search, so an unusable value must never reach it:
 * the fetch ceiling is derived from it (a fixed one above it makes the setting a no-op), and
 * a failed or absent settings read has to leave the default standing rather than zero it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SEARCH_BUDGET_MS,
  refreshSearchBudget,
  searchBudgetMs,
  searchFetchTimeoutMs,
} from '../src/search-budget';
import { FakeHost } from './grab-test-helpers';

function hostWith(value: string | undefined) {
  return new FakeHost().on('config.get', () =>
    value === undefined ? {} : { search_budget_seconds: value },
  );
}

describe('refreshSearchBudget', () => {
  test('an unset key keeps the default', async () => {
    assert.equal(await refreshSearchBudget(hostWith(undefined)), DEFAULT_SEARCH_BUDGET_MS);
  });

  test('a non-numeric value keeps the default instead of collapsing to 0', async () => {
    assert.equal(await refreshSearchBudget(hostWith('soon')), DEFAULT_SEARCH_BUDGET_MS);
  });

  test('a settings read that throws leaves the search budgeted', async () => {
    const host = new FakeHost().on('config.get', () => {
      throw new Error('host unavailable');
    });
    assert.equal(await refreshSearchBudget(host), DEFAULT_SEARCH_BUDGET_MS);
  });

  test('a valid value is applied and read back by the fan-out', async () => {
    await refreshSearchBudget(hostWith('60'));
    assert.equal(searchBudgetMs(), 60_000);
  });

  test('an out-of-range value is clamped at both ends', async () => {
    assert.equal(await refreshSearchBudget(hostWith('1')), 5_000);
    assert.equal(await refreshSearchBudget(hostWith('9000')), 120_000);
  });

  test('VERDICT: the fetch ceiling follows the budget — a fixed one would make the setting a no-op', async () => {
    await refreshSearchBudget(hostWith('120'));
    assert.ok(
      searchFetchTimeoutMs() < searchBudgetMs(),
      'a fetch outliving its budget leaks a socket nobody waits on',
    );
    assert.ok(searchFetchTimeoutMs() > 30_000, 'raising the budget must actually let a fetch run longer');
    await refreshSearchBudget(hostWith(undefined));
  });
});

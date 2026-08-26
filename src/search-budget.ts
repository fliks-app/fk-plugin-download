import type { HostCaller } from './grab/types';

/**
 * Ceiling on one indexer's contribution to a search fan-out, and so on the whole round —
 * indexers run concurrently, so the slowest one sets the wall clock. Sized for the reverse
 * proxy in front of Fliks rather than for core's 180s plugin-call deadline: nginx and friends
 * default to a 60s read timeout, and a 504 there discards every indexer that had answered.
 */
export const DEFAULT_SEARCH_BUDGET_MS = 30_000;
export const SEARCH_BUDGET_KEY = 'search_budget_seconds';

/** Below the floor a healthy tracker never answers in time; above the ceiling the reverse
 *  proxy cuts the response before the budget can return the partial results. */
const MIN_MS = 5_000;
const MAX_MS = 120_000;

/** One writer (`refreshSearchBudget`, called at the top of a search), read by the fan-out and
 *  by the fetch that runs under it. Concurrent searches share the value; both want the same one. */
let budgetMs: number = DEFAULT_SEARCH_BUDGET_MS;

export function searchBudgetMs(): number {
  return budgetMs;
}

/** The per-request fetch ceiling, derived rather than configured: a fixed value above the
 *  budget makes raising the budget a no-op, and one below it hides the budget entirely. */
export function searchFetchTimeoutMs(): number {
  return Math.round((budgetMs * 5) / 6);
}

/** Reads the admin's value once per search. An unset, unparseable or out-of-range value
 *  falls back to the default — the budget can never be configured into an instant timeout. */
export async function refreshSearchBudget(host: HostCaller): Promise<number> {
  let seconds = NaN;
  try {
    const values = await host.call('config.get', { keys: [SEARCH_BUDGET_KEY] });
    seconds = parseInt(values[SEARCH_BUDGET_KEY] ?? '', 10);
  } catch {
    // A settings read that fails must not fail the search it precedes.
  }
  budgetMs = Number.isFinite(seconds)
    ? Math.min(MAX_MS, Math.max(MIN_MS, seconds * 1000))
    : DEFAULT_SEARCH_BUDGET_MS;
  return budgetMs;
}

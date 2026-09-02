/**
 * The two persisted gates, `enableRss` and `enableSearch`, as the one choice an admin makes.
 *
 * Kept as a projection rather than a column: both gates are already enforced where they matter
 * (`rssSearch` and `resolveSearchTarget`), and nothing else has to learn a new field. What it
 * buys is that "neither" stops being expressible: an indexer marked enabled that answers no
 * search and no feed is a silent no-op, not a setting, and `enabled` already says "off".
 */
export const USE_FOR_VALUES = ['both', 'search', 'rss'] as const;

export type UseFor = (typeof USE_FOR_VALUES)[number];

export function isUseFor(value: unknown): value is UseFor {
  return typeof value === 'string' && (USE_FOR_VALUES as readonly string[]).includes(value);
}

/** A row with both gates off predates the choice (only an API caller could write it) and reads
 *  back as `both`: the state it names is the one `enabled: false` already covers. */
export function useForOf(row: { enableRss: boolean; enableSearch: boolean }): UseFor {
  if (row.enableRss && !row.enableSearch) return 'rss';
  if (row.enableSearch && !row.enableRss) return 'search';
  return 'both';
}

export function gatesFor(useFor: UseFor): { enableRss: boolean; enableSearch: boolean } {
  return {
    enableRss: useFor !== 'search',
    enableSearch: useFor !== 'rss',
  };
}

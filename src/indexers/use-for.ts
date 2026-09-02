/**
 * The three persisted gates, `enableRss`/`enableSearch`/`enableInteractiveSearch`, as the set
 * of usages an admin picks from. Independent on purpose: RSS sync, an automatic search and a
 * manual one are enforced in three different places (`rssSearch`, `resolveSearchTarget` for
 * each `SearchKind`), and none of them implies another.
 */
export const USE_FOR_VALUES = ['rss', 'auto', 'manual'] as const;

export type UseFor = (typeof USE_FOR_VALUES)[number];

export function isUseFor(value: unknown): value is UseFor {
  return typeof value === 'string' && (USE_FOR_VALUES as readonly string[]).includes(value);
}

/** Every entry known, and never empty: "no usage" is refused by the caller rather than
 *  silently persisted as an indexer that answers nothing. */
export function isUseForList(value: unknown): value is UseFor[] {
  return Array.isArray(value) && value.length > 0 && value.every(isUseFor);
}

export function useForOf(row: { enableRss: boolean; enableSearch: boolean; enableInteractiveSearch: boolean }): UseFor[] {
  const out: UseFor[] = [];
  if (row.enableRss) out.push('rss');
  if (row.enableSearch) out.push('auto');
  if (row.enableInteractiveSearch) out.push('manual');
  return out;
}

export function gatesFor(useFor: UseFor[]): { enableRss: boolean; enableSearch: boolean; enableInteractiveSearch: boolean } {
  const set = new Set(useFor);
  return {
    enableRss: set.has('rss'),
    enableSearch: set.has('auto'),
    enableInteractiveSearch: set.has('manual'),
  };
}

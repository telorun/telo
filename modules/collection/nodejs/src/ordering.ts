/** Shared multi-key ordering for the collection kinds (GroupBy.orderBy, Sort). */

export interface SortEntry {
  by: unknown;
  descending?: boolean;
}

/** Compares two sort keys: numerically when both are numbers, otherwise by
 *  deterministic UTF-16 code-unit order on the stringified keys. Locale-aware
 *  comparison is deliberately avoided — the ordering is a portable contract that
 *  must reproduce identically across runtimes and host locales (and it matches
 *  the CEL `sort()` builtin). */
export const compareKeys = (a: unknown, b: unknown): number => {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

/** Stable multi-key sort. `keysFor(item, index)` returns the tuple of sort keys
 *  for an element, aligned with `entries`; entries apply in order as
 *  tie-breakers, each honouring its `descending` flag. */
export function sortByEntries<T>(
  items: readonly T[],
  entries: readonly SortEntry[],
  keysFor: (item: T, index: number) => unknown[],
): T[] {
  const keyed = items.map((item, index) => ({ item, keys: keysFor(item, index) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < entries.length; i++) {
      const cmp = compareKeys(a.keys[i], b.keys[i]);
      if (cmp !== 0) return entries[i]!.descending ? -cmp : cmp;
    }
    return 0;
  });
  return keyed.map((k) => k.item);
}

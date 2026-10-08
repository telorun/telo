/** The query key an open surface is addressed by. Keys beginning `_telo` are
 *  the renderer's own. */
const keyOf = (name: string) => `_telo.open.${name}`;

/** What every query key holding a filter bar's state begins with. */
export const FILTER_KEYS = "_telo.f.";

const textOf = (query: URLSearchParams): string => {
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
};

/**
 * What a query string says about the surfaces addressed under a name: nothing
 * when the key is absent, the empty string for a new record, anything else the
 * key of the record being edited.
 */
export function openValue(search: string, name: string): string | undefined {
  return new URLSearchParams(search).get(keyOf(name)) ?? undefined;
}

/** The query string with the surfaces under each name closed, and — given a
 *  value — the one under `open.name` opened. */
export function withOpen(search: string, closed: (string | undefined)[], open?: { name: string; value: string }): string {
  const query = new URLSearchParams(search);
  for (const name of closed) if (name !== undefined) query.delete(keyOf(name));
  if (open) query.set(keyOf(open.name), open.value);
  return textOf(query);
}

const filterEntries = (search: string): [string, string][] =>
  [...new URLSearchParams(search)].filter(([key]) => key.startsWith(FILTER_KEYS));

/**
 * A query string holding the filter keys another holds, in place of its own:
 * what is open belongs to a history entry, what is filtered to the page across
 * its entries. Nothing when it holds them already.
 */
export function withFiltersOf(search: string, from: string): string | undefined {
  const carried = filterEntries(from);
  if (JSON.stringify(filterEntries(search)) === JSON.stringify(carried)) return undefined;
  const query = new URLSearchParams(search);
  for (const [key] of filterEntries(search)) query.delete(key);
  for (const [key, value] of carried) query.append(key, value);
  return textOf(query);
}

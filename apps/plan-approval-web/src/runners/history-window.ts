// A newest-first window over one of a runner's ever-growing lists (commands,
// inactive sessions): the newest page, extended by "Load older", and re-read
// in place — never the whole history.

export interface WindowPageQuery {
  order: "desc";
  after?: number;
  before?: number;
  limit: number;
}

export type FetchWindowPage<T> = (query: WindowPageQuery) => Promise<{ items: T[]; cursor: number }>;

export interface HistoryWindow<T> {
  /** Newest first. */
  items: T[];
  /** The key of the oldest entry loaded; 0 while nothing was. */
  oldest: number;
  /** Nothing older exists. */
  exhausted: boolean;
}

export const WINDOW_PAGE = 50;

export async function openWindow<T>(fetchPage: FetchWindowPage<T>, limit = WINDOW_PAGE): Promise<HistoryWindow<T>> {
  const page = await fetchPage({ order: "desc", limit });
  return { items: page.items, oldest: page.cursor, exhausted: page.items.length < limit };
}

export async function loadOlder<T>(
  current: HistoryWindow<T>,
  fetchPage: FetchWindowPage<T>,
  limit = WINDOW_PAGE,
): Promise<HistoryWindow<T>> {
  if (current.exhausted) return current;
  const page = await fetchPage({ order: "desc", before: current.oldest, limit });
  return {
    items: [...current.items, ...page.items],
    oldest: page.cursor,
    exhausted: page.items.length < limit,
  };
}

/** Re-reads what the window shows, paging down by `before` until a short page:
 *  its oldest entry and everything newer — or, once the window holds the whole
 *  list, everything, since a row may then enter at any key (a session turning
 *  inactive) with no "Load older" left to reach it. */
export async function refreshWindow<T>(
  current: HistoryWindow<T>,
  fetchPage: FetchWindowPage<T>,
  limit = WINDOW_PAGE,
): Promise<HistoryWindow<T>> {
  const after = current.exhausted ? 0 : Math.max(current.oldest - 1, 0);
  const items: T[] = [];
  let before: number | undefined;
  let cursor = current.oldest;
  for (;;) {
    const page = await fetchPage({ order: "desc", after, ...(before === undefined ? {} : { before }), limit });
    items.push(...page.items);
    cursor = page.cursor;
    if (page.items.length < limit) break;
    before = page.cursor;
  }
  return { items, oldest: current.exhausted ? cursor : current.oldest, exhausted: current.exhausted };
}

import { expect, it } from "vitest";

import { refreshWindow, type WindowPageQuery } from "@/runners/history-window";

it("re-reads only the displayed window, paging by `before` until a short page", async () => {
  const keys = [9, 8, 7, 6, 5, 4, 3, 2, 1];
  const asked: WindowPageQuery[] = [];
  const fetchPage = async (query: WindowPageQuery) => {
    asked.push(query);
    const items = keys
      .filter((key) => key > (query.after ?? 0) && key < (query.before ?? Infinity))
      .slice(0, query.limit);
    return { items, cursor: items.length > 0 ? items[items.length - 1] : (query.before ?? 0) };
  };

  // Commands 7–5 were on screen; 8 and 9 arrived since.
  const refreshed = await refreshWindow({ items: [7, 6, 5], oldest: 5, exhausted: false }, fetchPage, 2);

  expect(asked).toEqual([
    { order: "desc", after: 4, limit: 2 },
    { order: "desc", after: 4, before: 8, limit: 2 },
    { order: "desc", after: 4, before: 6, limit: 2 },
  ]);
  expect(refreshed).toEqual({ items: [9, 8, 7, 6, 5], oldest: 5, exhausted: false });
});

it("re-reads an exhausted window from the start, so a row entering below it shows", async () => {
  // Inactive sessions 3 and 2 were the whole list; session 1 turned inactive since.
  const asked: WindowPageQuery[] = [];
  const fetchPage = async (query: WindowPageQuery) => {
    asked.push(query);
    return { items: [3, 2, 1], cursor: 1 };
  };

  const refreshed = await refreshWindow({ items: [3, 2], oldest: 2, exhausted: true }, fetchPage, 50);

  expect(asked).toEqual([{ order: "desc", after: 0, limit: 50 }]);
  expect(refreshed).toEqual({ items: [3, 2, 1], oldest: 1, exhausted: true });
});

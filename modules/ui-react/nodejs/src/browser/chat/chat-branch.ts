import type { Entry } from "./chat-protocol.js";

/** A branch as drawn: its entries from the oldest read to the leaf, and where the ones above them are read from. */
export interface BranchView {
  entries: Entry[];
  /** The cursor reading the entries above the first; null when the first is a root. */
  earlier: string | null;
}

/**
 * The branch made of `pages`, read newest first as the server pages them (each page
 * itself newest first), laid over the entries already drawn. The oldest entry of the
 * pages that one already drawn is where they join: what is drawn above it is kept, and
 * everything from it down is the freshly read.
 */
export function joinPages(drawn: BranchView, pages: { rows: Entry[]; next: string | null }[]): BranchView {
  const known = new Map(drawn.entries.map((entry, index) => [entry.id, index]));
  const read = [...pages].reverse().flatMap((page) => [...page.rows].reverse());
  const join = read.findIndex((entry) => known.has(entry.id));
  if (join === -1) return { entries: read, earlier: pages[pages.length - 1].next };
  return { entries: [...drawn.entries.slice(0, known.get(read[join].id)), ...read.slice(join)], earlier: drawn.earlier };
}

/** Whether another page is needed: the pages so far neither reach an entry already drawn nor the root. */
export function needsMore(drawn: readonly Entry[], pages: { rows: Entry[]; next: string | null }[]): boolean {
  const last = pages[pages.length - 1];
  if (last.next === null || drawn.length === 0) return false;
  const known = new Set(drawn.map((entry) => entry.id));
  return !last.rows.some((entry) => known.has(entry.id));
}

/** Entries read above the first one drawn, put before it. */
export function prepend(drawn: BranchView, page: { rows: Entry[]; next: string | null }): BranchView {
  const have = new Set(drawn.entries.map((entry) => entry.id));
  return { entries: [...[...page.rows].reverse().filter((entry) => !have.has(entry.id)), ...drawn.entries], earlier: page.next };
}

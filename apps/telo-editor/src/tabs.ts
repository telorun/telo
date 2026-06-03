import type { EditorTab } from "./model";

/** Adds `tab` to the strip if no tab with the same path is open. Open tabs are
 *  keyed by path, so re-opening an already-open file is a no-op (caller just
 *  re-activates it). */
export function upsertTab(tabs: EditorTab[], tab: EditorTab): EditorTab[] {
  if (tabs.some((t) => t.path === tab.path)) return tabs;
  return [...tabs, tab];
}

export function closeTab(tabs: EditorTab[], path: string): EditorTab[] {
  return tabs.filter((t) => t.path !== path);
}

/** The tab to activate after `closed` is removed from the pre-removal `tabs`
 *  list. Prefers the neighbor to the right, then the left, else null. */
export function neighborTab(tabs: EditorTab[], closed: string): EditorTab | null {
  const idx = tabs.findIndex((t) => t.path === closed);
  if (idx === -1) return null;
  return tabs[idx + 1] ?? tabs[idx - 1] ?? null;
}

export function findTab(tabs: EditorTab[], path: string | null): EditorTab | null {
  if (path === null) return null;
  return tabs.find((t) => t.path === path) ?? null;
}

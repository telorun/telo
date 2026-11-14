import { browserStorage } from "./filter-state.js";

/** Where a navigation column keeps its open groups, as the layout document says. */
export type NavigationStore = { type: "memory" | "local" | "session" };

/** 3: one entry per column, holding its open groups alone; an aside's fold has its own key. */
const VERSION = 3;

/** The storage key of a navigation column: one per mount and `state.key`, so two
 *  columns keep their open groups apart. */
export const navigationStorageKey = (mount: string, key: string): string => `telo.ui:${mount === "" ? "/" : mount}:n:${key}`;

/** The storage a column's state is kept in, or none: memory, or a store the browser refuses. */
export function navigationStorage(store: NavigationStore): Storage | undefined {
  return store.type === "memory" ? undefined : browserStorage(store.type);
}

/** What a store holds for a column, held to the groups the tree has now:
 *  nothing when it holds no entry this renderer wrote. */
export function readNavigationStore(storage: Storage, key: string, groups: ReadonlySet<string>): string[] | undefined {
  const text = storage.getItem(key);
  if (text === null) return undefined;
  try {
    const entry = JSON.parse(text) as { v?: unknown; open?: unknown };
    if (entry?.v !== VERSION || !Array.isArray(entry.open)) return undefined;
    return entry.open.filter((group): group is string => typeof group === "string" && groups.has(group));
  } catch {
    // Not an entry this renderer wrote: it is left alone, and replaced by the next write.
    return undefined;
  }
}

/** Write a column's entry; `false` when the store takes nothing, which is
 *  said and then left alone — the state stays in memory. */
export function writeNavigationStore(storage: Storage, store: NavigationStore, key: string, open: string[]): boolean {
  try {
    storage.setItem(key, JSON.stringify({ v: VERSION, open }));
    return true;
  } catch (error) {
    console.error(`The browser refuses ${store.type} storage, so the navigation is kept in memory: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

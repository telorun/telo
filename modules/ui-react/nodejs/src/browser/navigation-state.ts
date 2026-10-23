import { browserStorage } from "./filter-state.js";

/** Where a sidebar keeps its state, as the application document says. */
export type NavigationStore = { type: "memory" | "local" | "session" };

/** What a sidebar keeps between visits: its open groups and whether its rail is collapsed. */
export interface SidebarState {
  open: string[];
  collapsed: boolean;
}

/** 2: groups named by their source texts' slugs, no longer by position. */
const VERSION = 2;

/** The storage key of an application's sidebar: one per mount, so two
 *  applications on one origin keep theirs apart. */
export const navigationStorageKey = (mount: string): string => `telo.ui:${mount === "" ? "/" : mount}:n`;

/** The storage a sidebar's state is kept in, or none: memory, or a store the browser refuses. */
export function navigationStorage(store: NavigationStore): Storage | undefined {
  return store.type === "memory" ? undefined : browserStorage(store.type);
}

/** What a store holds for a sidebar, held to the groups the tree has now:
 *  nothing when it holds no entry this renderer wrote. */
export function readNavigationStore(storage: Storage, key: string, groups: ReadonlySet<string>): Partial<SidebarState> | undefined {
  const text = storage.getItem(key);
  if (text === null) return undefined;
  try {
    const entry = JSON.parse(text) as { v?: unknown; open?: unknown; collapsed?: unknown };
    if (entry?.v !== VERSION) return undefined;
    return {
      ...(Array.isArray(entry.open) ? { open: entry.open.filter((group): group is string => typeof group === "string" && groups.has(group)) } : {}),
      ...(typeof entry.collapsed === "boolean" ? { collapsed: entry.collapsed } : {}),
    };
  } catch {
    // Not an entry this renderer wrote: it is left alone, and replaced by the next write.
    return undefined;
  }
}

/** Write a sidebar's entry; `false` when the store takes nothing, which is
 *  said and then left alone — the state stays in memory. */
export function writeNavigationStore(storage: Storage, store: NavigationStore, key: string, state: SidebarState): boolean {
  try {
    storage.setItem(key, JSON.stringify({ v: VERSION, open: state.open, collapsed: state.collapsed }));
    return true;
  } catch (error) {
    console.error(`The browser refuses ${store.type} storage, so the navigation is kept in memory: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

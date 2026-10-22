import type { BrowserEntryFiles } from "@telorun/sdk";

/** A control set as a check is handed it: what a `UiReact.Controls` provides. */
export interface CheckedSet {
  owner: string;
  files: BrowserEntryFiles;
  implements: string[];
}

/** A control set in the window: its module, or why it could not be drawn with. */
export interface LoadedSet {
  set: CheckedSet;
  /** The module, when it loaded and exports each control it implements. */
  module?: Record<string, unknown>;
  failure?: string;
}

/** Import each set's staged entry, `urls` in the order of `sets`. */
export async function loadSets(sets: CheckedSet[], urls: string[]): Promise<LoadedSet[]> {
  const loaded: LoadedSet[] = [];
  for (const [index, set] of sets.entries()) {
    try {
      const module = (await import(urls[index])) as Record<string, unknown>;
      const missing = set.implements.filter((name) => typeof module[name] !== "function" && (typeof module[name] !== "object" || module[name] === null));
      if (missing.length > 0) loaded.push({ set, failure: `its entry exports no control named ${missing.map((name) => `'${name}'`).join(", ")}` });
      else loaded.push({ set, module });
    } catch (error) {
      loaded.push({ set, failure: `its entry did not load: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return loaded;
}


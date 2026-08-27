import { useState } from "react";

import type { ViewProps } from "../types";
import { DefinitionTable } from "./DefinitionTable";
import { ImportTable } from "./ImportTable";
import { KindTable } from "./KindTable";
import { ResourceTable } from "./ResourceTable";

/** Everything the module DECLARES, as one list.
 *
 *  It replaced four tabs — resources, definitions, imports, kinds — that were
 *  four lists split by a taxonomy the reader does not have in mind when
 *  looking something up: a definition is a resource whose kind happens to be
 *  `Telo.Definition`, and a kind is what an import brought in. Splitting them
 *  meant knowing which tab a name lived in before you could search for it.
 *
 *  It LISTS and NAVIGATES; it does not edit. Selecting a row opens it in the
 *  detail panel, and the actions on these declarations — add / remove / upgrade
 *  an import, create a resource of a kind — live on the graph's declarations
 *  rail, which is visible while you work rather than instead of it. */
export function OutlineView(props: ViewProps) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name or kind…"
          className="w-64 rounded border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 outline-none placeholder:text-zinc-400 focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:focus:border-zinc-600"
        />
        {query && (
          <button
            type="button"
            onClick={() => setFilter("")}
            className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <ImportTable {...props} query={query} />
        <ResourceTable {...props} query={query} />
        <DefinitionTable {...props} query={query} />
        <KindTable {...props} query={query} />
      </div>
    </div>
  );
}

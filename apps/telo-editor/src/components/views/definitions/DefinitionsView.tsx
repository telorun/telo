import { getModuleFiles, summarizeResource } from "../../../diagnostics-aggregate";
import { DiagnosticBadge } from "../../diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "../../diagnostics/DiagnosticsContext";
import { rowBase, rowHover } from "../../sidebar/primitives";
import type { ViewProps } from "../types";

/** Module-view tab listing the module's `Telo.Definition` resources. Selecting
 *  one opens it in the detail panel — the same behavior the sidebar section had,
 *  now hosted as a top-level module tab. */
export function DefinitionsView({ viewData, selectedResource, onSelectResource }: ViewProps) {
  const definitions = viewData.manifest.resources.filter((r) => r.kind === "Telo.Definition");
  const diagState = useDiagnosticsState();
  const filePaths = getModuleFiles(viewData.manifest);

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      <div className="flex shrink-0 items-center border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          Definitions
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {definitions.length === 0 && (
          <div className="px-4 py-1 text-xs italic text-zinc-400 dark:text-zinc-600">
            No definitions
          </div>
        )}
        {definitions.map((r) => {
          const isSelected = selectedResource?.kind === r.kind && selectedResource?.name === r.name;
          const stateCls = isSelected
            ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100"
            : `text-zinc-600 dark:text-zinc-400 ${rowHover}`;
          const summary = summarizeResource(diagState, filePaths, r.name);
          return (
            <div
              key={r.name}
              className={`${rowBase} ${stateCls}`}
              onClick={() => onSelectResource(r.kind, r.name)}
            >
              <span className="min-w-0 truncate">{r.name}</span>
              <DiagnosticBadge summary={summary} size="sm" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { DiagnosticSeverity } from "@telorun/analyzer";
import { summarizeResource, type DiagnosticsSummary } from "../../../diagnostics-aggregate";
import { DiagnosticBadge } from "../../diagnostics/DiagnosticBadge";
import {
  useActiveFilePaths,
  useDiagnosticsState,
} from "../../diagnostics/DiagnosticsContext";
import { CapabilityBadge, TopologyBadge } from "../shared/resource-badges";
import type { ViewProps } from "../types";

/** Module-view tab listing the module's user resources (non-`Telo.*`).
 *  `Telo.Definition` resources live in their own Definitions tab, so they are
 *  intentionally excluded here. */
export function ResourcesView({
  viewData,
  selectedResource,
  graphContext,
  onSelectResource,
  onNavigateResource,
}: ViewProps) {
  const userResources = viewData.manifest.resources.filter((r) => !r.kind.startsWith("Telo."));
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();

  function rowClassName(kind: string, name: string, summary: DiagnosticsSummary | null): string {
    const isSelected = selectedResource?.kind === kind && selectedResource?.name === name;
    const isGraphContext = graphContext?.kind === kind && graphContext?.name === name;

    const border =
      summary?.worstSeverity === DiagnosticSeverity.Error
        ? "border-l-2 border-l-red-400 dark:border-l-red-500"
        : summary
          ? "border-l-2 border-l-amber-400 dark:border-l-amber-500"
          : "border-l-2 border-l-transparent";

    if (isSelected) return `${border} bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100`;
    if (isGraphContext)
      return `${border} bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200`;
    return `${border} text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900/50`;
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      {userResources.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          <span className="text-sm text-zinc-400 dark:text-zinc-600">
            No resources — use the Topology view to create one
          </span>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 pt-3 pb-2">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                <th className="w-5 pb-1.5" />
                <th className="pb-1.5 pr-3 font-medium">Name</th>
                <th className="pb-1.5 pr-3 font-medium">Kind</th>
                <th className="pb-1.5 pr-3 font-medium">Capability</th>
                <th className="pb-1.5 font-medium">Topology</th>
              </tr>
            </thead>
            <tbody>
              {userResources.map((r) => {
                const kind = viewData.kinds.get(r.kind);
                const hasTopology = !!kind?.topology;
                const summary = summarizeResource(diagState, filePaths, r.name);
                return (
                  <tr
                    key={`${r.kind}/${r.name}`}
                    className={`cursor-pointer border-b border-zinc-100 dark:border-zinc-800/50 ${rowClassName(r.kind, r.name, summary)}`}
                    onClick={() => onSelectResource(r.kind, r.name)}
                  >
                    <td className="w-5 py-1.5 text-center">
                      <DiagnosticBadge summary={summary} size="sm" showCount={false} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{r.name}</span>
                        {hasTopology && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onNavigateResource(r.kind, r.name);
                            }}
                            title="Open in topology view"
                            className="shrink-0 rounded px-1 text-xs text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                          >
                            ↗
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className="text-zinc-400 dark:text-zinc-500">
                        {r.kind.split(".")[0]}.
                      </span>
                      <span>{r.kind.split(".").slice(1).join(".")}</span>
                    </td>
                    <td className="py-1.5 pr-3">
                      {kind?.capability && <CapabilityBadge capability={kind.capability} />}
                    </td>
                    <td className="py-1.5">
                      {kind?.topology && <TopologyBadge topology={kind.topology} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

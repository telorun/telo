import { DiagnosticSeverity } from "@telorun/analyzer";
import { summarizeResource, type DiagnosticsSummary } from "../../../diagnostics-aggregate";
import { DiagnosticBadge } from "../../diagnostics/DiagnosticBadge";
import { useActiveFilePaths, useDiagnosticsState } from "../../diagnostics/DiagnosticsContext";
import { CapabilityBadge } from "../shared/resource-badges";
import type { ViewProps } from "../types";
import { matches, OutlineHead, OutlineSection } from "./outline-table";

/** The module's user resources (non-`Telo.*`) — what it RUNS, as opposed to
 *  what it declares about itself. */
export function ResourceTable({
  viewData,
  selectedResource,
  onSelectResource,
  onNavigateResource,
  query,
}: ViewProps & { query: string }) {
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();
  const resources = viewData.manifest.resources.filter(
    (r) => !r.kind.startsWith("Telo.") && matches(query, r.name, r.kind),
  );

  function rowClassName(kind: string, name: string, summary: DiagnosticsSummary | null): string {
    const isSelected = selectedResource?.kind === kind && selectedResource?.name === name;
    const border =
      summary?.worstSeverity === DiagnosticSeverity.Error
        ? "border-l-2 border-l-red-400 dark:border-l-red-500"
        : summary
          ? "border-l-2 border-l-amber-400 dark:border-l-amber-500"
          : "border-l-2 border-l-transparent";
    if (isSelected) return `${border} bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100`;
    return `${border} text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900/50`;
  }

  return (
    <OutlineSection
      title="Resources"
      count={resources.length}
      filtered={query !== ""}
      emptyText="No resources — create one from the graph"
    >
      <table className="w-full text-left text-sm">
        <OutlineHead columns={[null, "Name", "Kind", "Capability"]} />
        <tbody>
          {resources.map((r) => {
            const kind = viewData.kinds.get(r.kind);
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
                    {/* Every resource is somewhere in the module's containment
                        tree, so every row can be navigated to; the topology host
                        resolves the route. */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigateResource(r.kind, r.name);
                      }}
                      title="Show in the graph"
                      className="shrink-0 rounded px-1 text-xs text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                    >
                      ↗
                    </button>
                  </div>
                </td>
                <td className="py-1.5 pr-3">
                  <span className="text-zinc-400 dark:text-zinc-500">{r.kind.split(".")[0]}.</span>
                  <span>{r.kind.split(".").slice(1).join(".")}</span>
                </td>
                <td className="py-1.5">
                  {kind?.capability && <CapabilityBadge capability={kind.capability} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </OutlineSection>
  );
}

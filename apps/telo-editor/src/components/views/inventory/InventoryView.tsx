import { DiagnosticSeverity } from "@telorun/analyzer";
import { summarizeResource, type DiagnosticsSummary } from "../../../diagnostics-aggregate";
import { DiagnosticBadge } from "../../diagnostics/DiagnosticBadge";
import {
  useActiveFilePaths,
  useDiagnosticsState,
} from "../../diagnostics/DiagnosticsContext";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import type { ViewProps } from "../types";

function capabilityLabel(cap: string): string {
  const dot = cap.lastIndexOf(".");
  return dot >= 0 ? cap.slice(dot + 1) : cap;
}

const capabilityColors: Record<string, string> = {
  Service: "bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200",
  Runnable: "bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-200",
  Invocable: "bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-200",
  Provider: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/60 dark:text-cyan-200",
  Mount: "bg-pink-100 text-pink-700 dark:bg-pink-900/60 dark:text-pink-200",
  Type: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

function CapabilityBadge({ capability }: { capability: string }) {
  const label = capabilityLabel(capability);
  const color = capabilityColors[label] ?? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${color}`}>
      {label}
    </span>
  );
}

function TopologyBadge({ topology }: { topology: string }) {
  return (
    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-900/60 dark:text-amber-200">
      {topology}
    </span>
  );
}

export function InventoryView({
  viewData,
  selectedResource,
  graphContext,
  onSelectResource,
  onNavigateResource,
}: ViewProps) {
  const userResources = viewData.manifest.resources.filter((r) => !r.kind.startsWith("Telo."));
  const definitions = viewData.manifest.resources.filter((r) => r.kind === "Telo.Definition");
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();

  function rowClassName(
    kind: string,
    name: string,
    summary: DiagnosticsSummary | null,
  ): string {
    const isSelected = selectedResource?.kind === kind && selectedResource?.name === name;
    const isGraphContext = graphContext?.kind === kind && graphContext?.name === name;

    const border =
      summary?.worstSeverity === DiagnosticSeverity.Error
        ? "border-l-2 border-l-red-400 dark:border-l-red-500"
        : summary
          ? "border-l-2 border-l-amber-400 dark:border-l-amber-500"
          : "border-l-2 border-l-transparent";

    if (isSelected) return `${border} bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100`;
    if (isGraphContext) return `${border} bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200`;
    return `${border} text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900/50`;
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      <Tabs defaultValue="resources" className="flex h-full flex-col">
        <TabsList variant="line" className="shrink-0 border-b border-zinc-200 px-4 dark:border-zinc-800">
          <TabsTrigger value="resources" className="text-xs">
            Resources
          </TabsTrigger>
          <TabsTrigger value="imports" className="text-xs">
            Imports
          </TabsTrigger>
          <TabsTrigger value="kinds" className="text-xs">
            Kinds
          </TabsTrigger>
        </TabsList>

        {/* Resources tab */}
        <TabsContent value="resources" className="flex-1 overflow-y-auto">
          {userResources.length === 0 && definitions.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <span className="text-sm text-zinc-400 dark:text-zinc-600">
                No resources — use the sidebar to create one
              </span>
            </div>
          ) : (
            <div className="px-4 pt-3 pb-2">
              {/* User resources */}
              {userResources.length > 0 && (
                <>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                    Resources
                  </h3>
                  <table className="mb-4 w-full text-left text-sm">
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
                            <td className="py-1.5 w-5 text-center">
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
                </>
              )}

              {/* Definitions */}
              {definitions.length > 0 && (
                <>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                    Definitions
                  </h3>
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-zinc-200 text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                        <th className="w-5 pb-1.5" />
                        <th className="pb-1.5 pr-3 font-medium">Name</th>
                        <th className="pb-1.5 pr-3 font-medium">Capability</th>
                        <th className="pb-1.5 font-medium">Topology</th>
                      </tr>
                    </thead>
                    <tbody>
                      {definitions.map((r) => {
                        const capability =
                          typeof r.fields.capability === "string" ? r.fields.capability : "";
                        const topology =
                          typeof r.fields.topology === "string" ? r.fields.topology : undefined;
                        const summary = summarizeResource(diagState, filePaths, r.name);
                        return (
                          <tr
                            key={r.name}
                            className={`cursor-pointer border-b border-zinc-100 dark:border-zinc-800/50 ${rowClassName(r.kind, r.name, summary)}`}
                            onClick={() => onSelectResource(r.kind, r.name)}
                          >
                            <td className="py-1.5 w-5 text-center">
                              <DiagnosticBadge summary={summary} size="sm" showCount={false} />
                            </td>
                            <td className="py-1.5 pr-3 font-medium">{r.name}</td>
                            <td className="py-1.5 pr-3">
                              {capability && <CapabilityBadge capability={capability} />}
                            </td>
                            <td className="py-1.5">
                              {topology && <TopologyBadge topology={topology} />}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </TabsContent>

        {/* Imports tab */}
        <TabsContent value="imports" className="flex-1 overflow-y-auto">
          {viewData.manifest.imports.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <span className="text-sm text-zinc-400 dark:text-zinc-600">No imports</span>
            </div>
          ) : (
            <div className="px-4 pt-3 pb-2">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                    <th className="pb-1.5 pr-3 font-medium">Alias</th>
                    <th className="pb-1.5 pr-3 font-medium">Source</th>
                    <th className="pb-1.5 pr-3 font-medium">Type</th>
                    <th className="pb-1.5 font-medium">Resolved Path</th>
                  </tr>
                </thead>
                <tbody>
                  {viewData.manifest.imports.map((imp) => (
                    <tr
                      key={imp.name}
                      className="border-b border-zinc-100 text-zinc-700 dark:border-zinc-800/50 dark:text-zinc-300"
                    >
                      <td className="py-1.5 pr-3 font-medium text-xs">{imp.name}</td>
                      <td className="py-1.5 pr-3 text-xs truncate max-w-64">{imp.source}</td>
                      <td className="py-1.5 pr-3 text-xs">{imp.importKind}</td>
                      <td className="py-1.5 text-xs truncate max-w-64 text-zinc-400 dark:text-zinc-500">
                        {imp.resolvedPath ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        {/* Kinds tab */}
        <TabsContent value="kinds" className="flex-1 overflow-y-auto">
          {viewData.kinds.size === 0 ? (
            <div className="flex h-full items-center justify-center">
              <span className="text-sm text-zinc-400 dark:text-zinc-600">No kinds resolved</span>
            </div>
          ) : (
            <div className="px-4 pt-3 pb-2">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                    <th className="pb-1.5 pr-3 font-medium">Kind</th>
                    <th className="pb-1.5 pr-3 font-medium">Alias</th>
                    <th className="pb-1.5 pr-3 font-medium">Capability</th>
                    <th className="pb-1.5 font-medium">Topology</th>
                  </tr>
                </thead>
                <tbody>
                  {[...viewData.kinds.values()].map((k) => (
                    <tr
                      key={k.fullKind}
                      className="border-b border-zinc-100 text-zinc-700 dark:border-zinc-800/50 dark:text-zinc-300"
                    >
                      <td className="py-1.5 pr-3 text-xs">{k.fullKind}</td>
                      <td className="py-1.5 pr-3 text-xs">{k.alias}</td>
                      <td className="py-1.5 pr-3">
                        {k.capability && <CapabilityBadge capability={k.capability} />}
                      </td>
                      <td className="py-1.5">
                        {k.topology && <TopologyBadge topology={k.topology} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

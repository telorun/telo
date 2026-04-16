import { DiagnosticSeverity, type AnalysisDiagnostic } from "@telorun/analyzer";
import type { ViewProps } from "../types";

function DiagnosticIndicator({ diagnostics }: { diagnostics: AnalysisDiagnostic[] }) {
  if (diagnostics.length === 0) return null;

  const hasError = diagnostics.some((d) => d.severity === DiagnosticSeverity.Error);
  const iconColor = hasError
    ? "text-red-500 dark:text-red-400"
    : "text-amber-500 dark:text-amber-400";

  const tooltip = diagnostics.map((d) => d.message).join("\n");

  return (
    <span className={`cursor-help ${iconColor}`} title={tooltip}>
      {hasError ? "●" : "▲"}
    </span>
  );
}

function capabilityLabel(cap: string): string {
  // "Kernel.Service" → "Service", "Kernel.Invocable" → "Invocable"
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
  const userResources = viewData.manifest.resources.filter((r) => !r.kind.startsWith("Kernel."));
  const definitions = viewData.manifest.resources.filter((r) => r.kind === "Kernel.Definition");

  if (userResources.length === 0 && definitions.length === 0) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-900">
        <span className="text-sm text-zinc-400 dark:text-zinc-600">
          No resources — use the sidebar to create one
        </span>
      </div>
    );
  }

  function rowClassName(kind: string, name: string): string {
    const isSelected = selectedResource?.kind === kind && selectedResource?.name === name;
    const isGraphContext = graphContext?.kind === kind && graphContext?.name === name;
    const hasDiagnostics = (viewData.diagnostics.get(name)?.length ?? 0) > 0;
    const hasError = viewData.diagnostics.get(name)?.some((d) => d.severity === DiagnosticSeverity.Error);

    const border = hasDiagnostics
      ? hasError
        ? "border-l-2 border-l-red-400 dark:border-l-red-500"
        : "border-l-2 border-l-amber-400 dark:border-l-amber-500"
      : "border-l-2 border-l-transparent";

    if (isSelected) return `${border} bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100`;
    if (isGraphContext) return `${border} bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200`;
    return `${border} text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900/50`;
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-y-auto bg-zinc-50 dark:bg-zinc-900">
      {/* User resources */}
      {userResources.length > 0 && (
        <div className="px-4 pt-4 pb-2">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Resources
          </h3>
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
                const diagnostics = viewData.diagnostics.get(r.name) ?? [];
                return (
                  <tr
                    key={`${r.kind}/${r.name}`}
                    className={`cursor-pointer border-b border-zinc-100 dark:border-zinc-800/50 ${rowClassName(r.kind, r.name)}`}
                    onClick={() => onSelectResource(r.kind, r.name)}
                  >
                    <td className="py-1.5 w-5 text-center">
                      <DiagnosticIndicator diagnostics={diagnostics} />
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

      {/* Definitions */}
      {definitions.length > 0 && (
        <div className="px-4 pt-4 pb-2">
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
                const diagnostics = viewData.diagnostics.get(r.name) ?? [];
                return (
                  <tr
                    key={r.name}
                    className={`cursor-pointer border-b border-zinc-100 dark:border-zinc-800/50 ${rowClassName(r.kind, r.name)}`}
                    onClick={() => onSelectResource(r.kind, r.name)}
                  >
                    <td className="py-1.5 w-5 text-center">
                      <DiagnosticIndicator diagnostics={diagnostics} />
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
        </div>
      )}
    </div>
  );
}

import { useMemo } from "react";
import type { ResolvedResourceOption } from "../../resource-schema-form/types";
import { PickCanvas } from "../pick-canvas";
import type { ViewProps } from "../types";

export function TopologyView({
  viewData,
  graphContext,
  onUpdateResource,
  onSelectResource,
  onSelect,
  onClearSelection,
}: ViewProps) {
  const graphResource = graphContext
    ? (viewData.manifest.resources.find(
        (r) => r.kind === graphContext.kind && r.name === graphContext.name,
      ) ?? null)
    : null;

  const graphKind = graphResource ? (viewData.kinds.get(graphResource.kind) ?? null) : null;
  const graphTopology = graphKind?.topology;
  const graphSchema = graphKind?.schema;

  const resolvedResources = useMemo<ResolvedResourceOption[]>(
    () =>
      viewData.manifest.resources.map((r) => ({
        kind: r.kind,
        name: r.name,
        capability: viewData.kinds.get(r.kind)?.capability || undefined,
      })),
    [viewData],
  );

  if (graphResource && graphSchema) {
    return (
      <PickCanvas
        resource={graphResource}
        schema={graphSchema}
        topology={graphTopology}
        resolvedResources={resolvedResources}
        onUpdateResource={onUpdateResource}
        onSelectResource={onSelectResource}
        onSelect={onSelect}
        onBackgroundClick={onClearSelection}
      />
    );
  }

  return (
    <div
      className="flex h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-900"
      onClick={onClearSelection}
    >
      <span className="text-sm text-zinc-400 dark:text-zinc-600 pointer-events-none">
        Select a resource to open its canvas
      </span>
    </div>
  );
}

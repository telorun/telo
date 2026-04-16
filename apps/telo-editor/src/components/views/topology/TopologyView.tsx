import type { ViewProps } from "../types";
import { RouterTopologyCanvas } from "./RouterTopologyCanvas";
import { SequenceTopologyCanvas } from "./SequenceTopologyCanvas";

export function TopologyView({
  viewData,
  graphContext,
  onUpdateResource,
  onSelect,
  onClearSelection,
}: ViewProps) {
  // Derive topology-specific state from the shared view data
  const graphResource = graphContext
    ? (viewData.manifest.resources.find(
        (r) => r.kind === graphContext.kind && r.name === graphContext.name,
      ) ?? null)
    : null;

  const graphKind = graphResource ? (viewData.kinds.get(graphResource.kind) ?? null) : null;
  const graphTopology = graphKind?.topology;
  const graphSchema = graphKind?.schema;

  if (graphTopology === "Router" && graphResource && graphSchema) {
    return (
      <RouterTopologyCanvas
        resource={graphResource}
        schema={graphSchema}
        onUpdateResource={onUpdateResource}
        onSelect={onSelect}
        onBackgroundClick={onClearSelection}
      />
    );
  }

  if (graphTopology === "Sequence" && graphResource && graphSchema) {
    return (
      <SequenceTopologyCanvas
        resource={graphResource}
        schema={graphSchema}
        onUpdateResource={onUpdateResource}
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
        {graphResource
          ? `${graphResource.kind} does not have a canvas renderer yet`
          : "Select a topology-aware resource to open its canvas"}
      </span>
    </div>
  );
}

import { useMemo } from "react";
import { MODULE_OVERVIEW_TOPOLOGY } from "../../../application-adapter";
import type { ResolvedResourceOption } from "../../resource-schema-form/types";
import { PickCanvas } from "../pick-canvas";
import type { ViewProps } from "../types";
import {
  buildApplicationCanvasModel,
  type AppCanvasModel,
} from "./application-canvas-model";

export function TopologyView({
  viewData,
  registry,
  graphContext,
  selectedResource,
  onUpdateResource,
  onDeleteResource,
  onUpdateApplicationTargets,
  onCreateResource,
  onSelectResource,
  onSelect,
  onClearSelection,
  canvasViewport,
  onCanvasViewportChange,
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

  // Same overview model for both module roots; a Library has no `targets`.
  const applicationModel = useMemo<AppCanvasModel | null>(() => {
    if (graphTopology !== MODULE_OVERVIEW_TOPOLOGY || !registry) return null;
    const targets = viewData.manifest.kind === "Application" ? viewData.manifest.targets : [];
    return buildApplicationCanvasModel(viewData, registry, targets);
  }, [graphTopology, registry, viewData]);

  // Drag-to-wire edits `targets`, which only Applications have.
  const isApplication = viewData.manifest.kind === "Application";

  if (graphResource && graphSchema) {
    return (
      <PickCanvas
        resource={graphResource}
        schema={graphSchema}
        topology={graphTopology}
        resolvedResources={resolvedResources}
        applicationModel={applicationModel}
        viewportKey={viewData.manifest.filePath}
        canvasViewport={canvasViewport}
        onCanvasViewportChange={onCanvasViewportChange}
        selectedResource={selectedResource}
        onDeleteResource={onDeleteResource}
        onUpdateApplicationTargets={isApplication ? onUpdateApplicationTargets : undefined}
        onCreateResource={onCreateResource}
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

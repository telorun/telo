import { TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { MODULE_OVERVIEW_TOPOLOGY } from "../../../application-adapter";
import { DetailPanel } from "../../DetailPanel";
import type { ResolvedResourceOption, TypeKindOption } from "../../resource-schema-form/types";
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
  selection,
  onUpdateResource,
  onDeleteResource,
  onWriteRef,
  onCreateResource,
  onSelectResource,
  onSelect,
  onNavigateResource,
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

  const typeKinds = useMemo<TypeKindOption[]>(
    () =>
      [...viewData.kinds.values()]
        .filter((k) => k.capability === "Telo.Type")
        .map((k) => ({ kind: k.fullKind, schema: k.schema })),
    [viewData],
  );

  // Same overview model for both module roots; a Library has no `targets`.
  const applicationModel = useMemo<AppCanvasModel | null>(() => {
    if (graphTopology !== MODULE_OVERVIEW_TOPOLOGY || !registry) return null;
    const targets = viewData.manifest.kind === "Application" ? viewData.manifest.targets : [];
    return buildApplicationCanvasModel(viewData, registry, targets);
  }, [graphTopology, registry, viewData]);

  const canvas =
    graphResource && graphSchema ? (
      <PickCanvas
        resource={graphResource}
        schema={graphSchema}
        topology={graphTopology}
        resolvedResources={resolvedResources}
        typeKinds={typeKinds}
        registry={registry}
        applicationModel={applicationModel}
        viewportKey={viewData.manifest.filePath}
        canvasViewport={canvasViewport}
        onCanvasViewportChange={onCanvasViewportChange}
        selectedResource={selectedResource}
        selection={selection}
        onDeleteResource={onDeleteResource}
        onWriteRef={onWriteRef}
        onCreateResource={onCreateResource}
        onUpdateResource={onUpdateResource}
        onSelectResource={onSelectResource}
        onSelect={onSelect}
        onBackgroundClick={onClearSelection}
      />
    ) : (
      <div
        className="flex h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-900"
        onClick={onClearSelection}
      >
        <span className="text-sm text-zinc-400 dark:text-zinc-600 pointer-events-none">
          Select a resource to open its canvas
        </span>
      </div>
    );

  // The detail panel belongs to the canvas — it edits the selected node and is
  // meaningless on the other module tabs (Imports, Definitions, …), so it lives
  // here rather than alongside the tab container. Renders null when nothing is
  // selected, so it only takes space when a resource is in focus.
  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span>
            The Telo editor is an early preview — visual editing isn't fully supported yet and some
            changes may not apply. Use the Source tab if something looks off.
          </span>
        </div>
        <div className="relative flex min-h-0 flex-1">{canvas}</div>
      </div>
      <DetailPanel
        selectedResource={selectedResource}
        graphContext={graphContext}
        selection={selection}
        viewData={viewData}
        registry={registry}
        onUpdateResource={onUpdateResource}
        onSelectResource={onSelectResource}
        onSelect={onSelect}
        onNavigateResource={onNavigateResource}
      />
    </div>
  );
}

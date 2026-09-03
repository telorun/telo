import { useCallback, useEffect, useMemo } from "react";
import {
  isModuleRootKind,
  moduleRootResource,
  MODULE_OVERVIEW_TOPOLOGY,
} from "../../../application-adapter";
import { DetailPanel } from "../../DetailPanel";
import type { ResolvedResourceOption, TypeKindOption } from "../../resource-schema-form/types";
import type { ViewProps } from "../types";
import { ModuleGraphView } from "./module-graph-view/ModuleGraphView";
import { ModuleBar } from "./ModuleBar";
import { PreviewNotice } from "./PreviewNotice";
import type { TopologyViewProps } from "./topology-view";

/**
 * Host for the topology tab.
 *
 * **The canvas is the module graph, always.** It used to resolve a view per
 * FOCUS, so selecting a route or a step re-rooted the whole surface onto that
 * resource's own editor: the graph vanished, the panel changed under it, and the
 * way back was a breadcrumb the reader had to notice. Selecting a thing is not a
 * request to leave the place you are looking at.
 *
 * The kind-declared editors (Routes, Steps, Entries, Fields) still exist and are
 * still the right surface for a body — they render in the DETAIL PANEL, beside
 * the graph, for whatever is selected. So a click on a row now does what a click
 * on a row should: shows you that thing, where you are.
 */
export function TopologyView({
  readOnly,
  viewData,
  registry,
  moduleGraph,
  moduleGraphFor,
  isEditableModule,
  selectedResource,
  selection,
  onUpdateResource,
  onDeleteResource,
  onWriteRef,
  onCreateAndLink,
  onCreateResource,
  onCreateResourceOfKind,
  onMoveField,
  onRelocateField,
  onRemoveField,
  onSelectResource,
  onSelect,
  onClearSelection,
  onOpenModule,
  onSourceEdit,
  onExtractInline,
  onInlineReference,
  onAddImport,
  onRenameField,
  onRemoveImport,
  onUpgradeImport,
  onUpgradeAllImports,
  importableLibraries,
  hubUrl,
  manifestCacheUrl,
  topology,
}: ViewProps) {
  // The synthesized module root, which `buildModuleViewData` puts in the
  // resource list so every surface finds it through the same lookups.
  const root = viewData.manifest.resources.find((r) => isModuleRootKind(r.kind)) ?? null;
  const rootKind = root ? (viewData.kinds.get(root.kind) ?? null) : null;

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

  // A request from another tab names a resource. It is a request to LOOK at
  // that resource, which is a selection — there is nowhere to navigate to, and
  // the graph draws it wherever it is.
  const focusRequest = topology.focusRequest;
  const onFocusPath = topology.onFocusPath;
  useEffect(() => {
    if (!focusRequest) return;
    const target = viewData.manifest.resources.find((r) => r.name === focusRequest);
    if (target) onSelectResource(target.kind, target.name);
    // Clearing the request is what stops it re-firing on every pass and dragging
    // the reader back here after they have moved on.
    onFocusPath([]);
  }, [focusRequest, viewData, onSelectResource, onFocusPath]);

  const onViewState = topology.onViewState;
  const onStateChange = useCallback(
    (next: unknown) => onViewState(GRAPH_VIEW_ID, next),
    [onViewState],
  );

  const hostViewportFor = topology.viewportFor;
  const hostViewportChange = topology.onViewportChange;
  const viewportFor = useCallback(
    (key: string) => hostViewportFor(`${GRAPH_VIEW_ID}#${key}`),
    [hostViewportFor],
  );
  const onViewportChange = useCallback<TopologyViewProps["onViewportChange"]>(
    (key, viewport) => hostViewportChange(`${GRAPH_VIEW_ID}#${key}`, viewport),
    [hostViewportChange],
  );

  const canvasProps: TopologyViewProps | null =
    root && rootKind?.schema && rootKind.topology === MODULE_OVERVIEW_TOPOLOGY
      ? {
          moduleGraph,
          moduleGraphFor,
          isEditableModule,
          viewData,
          registry,
          refResolver: registry,
          resource: root,
          schema: rootKind.schema,
          resolvedResources,
          typeKinds,
          selectedResource,
          selection,
          state: topology.viewState[GRAPH_VIEW_ID],
          onStateChange,
          viewportFor,
          onViewportChange,
          onSelectResource,
          onSelect,
          onUpdateResource,
          onCreateAndLink,
          onDeleteResource,
          onWriteRef,
          onCreateResource,
          onMoveField,
          onRelocateField,
          onRemoveField,
          onExtractInline,
          onBackgroundClick: onClearSelection,
        }
      : null;

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      {/* Module chrome, not canvas content: what a module DECLARES is true
          whichever resource is selected, and none of it is graph data —
          `imports`, `variables`, `secrets`, `ports` and `exports` reference
          nothing and are referenced by nothing, so no edge carries them and no
          box can hold them. */}
      <ModuleBar
        viewData={viewData}
        root={moduleRootResource(viewData.manifest)}
        readOnly={readOnly}
        hubUrl={hubUrl}
        manifestCacheUrl={manifestCacheUrl}
        importableLibraries={importableLibraries}
        selection={selection}
        onAddImport={onAddImport}
        onRenameField={onRenameField}
        onRemoveImport={onRemoveImport}
        onUpgradeImport={onUpgradeImport}
        onUpgradeAllImports={onUpgradeAllImports}
        onOpenModule={onOpenModule}
        onUpdateResource={onUpdateResource}
        onCreateResourceOfKind={onCreateResourceOfKind}
        onSelect={onSelect}
      />
      {/* `min-w-0` so an oversized canvas clips rather than pushing the row
          wider; the floor that keeps the content from being squeezed to nothing
          is the detail panel's `flex-1` cap, not a width here. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <PreviewNotice />
        <div className="relative flex min-h-0 flex-1">
          {canvasProps ? (
            <ModuleGraphView {...canvasProps} />
          ) : (
            <div
              className="flex h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-900"
              onClick={onClearSelection}
            >
              <span className="text-sm text-zinc-400 dark:text-zinc-600">
                This module has no canvas yet
              </span>
            </div>
          )}
        </div>
      </div>
      <DetailPanel
        selectedResource={selectedResource}
        selection={selection}
        // The canvas draws the module, never one resource's body — so the panel
        // is where a body is edited and nothing is drawn twice.
        canvasResource={null}
        viewData={viewData}
        registry={registry}
        readOnly={readOnly}
        onSourceEdit={onSourceEdit}
        onExtractInline={onExtractInline}
        onInlineReference={onInlineReference}
        onUpdateResource={onUpdateResource}
        onSelectResource={onSelectResource}
        onSelect={onSelect}
        onCreateAndLink={onCreateAndLink}
      />
    </div>
  );
}

/** The one canvas's id, for the per-view state bag and viewport the host keeps. */
const GRAPH_VIEW_ID = "graph";

import { useCallback, useEffect, useMemo } from "react";
import {
  isModuleRootKind,
  moduleRootResource,
  MODULE_OVERVIEW_TOPOLOGY,
} from "../../../application-adapter";
import { getStepSchema } from "../../../schema-utils";
import { entryListOf } from "./entry-list-model";
import { DetailPanel } from "../../DetailPanel";
import type { ResolvedResourceOption, TypeKindOption } from "../../resource-schema-form/types";
import type { ViewProps } from "../types";
import {
  buildApplicationCanvasModel,
  type AppCanvasModel,
} from "./application-canvas-model";
import { Breadcrumb } from "./Breadcrumb";
import {
  childCountOf,
  findPathTo,
  focusedId,
  resolveFocusPath,
  buildContainmentTree,
} from "./containment";
import { ModuleBar } from "./ModuleBar";
import { PreviewNotice } from "./PreviewNotice";
import { PropertyRail } from "./PropertyRail";
import type { TopologyViewContext, TopologyViewProps } from "./topology-view";
import {
  resolveView,
  viewChoiceKey,
  candidateViews,
  consumedFields,
  worthFocusing,
} from "./view-registry";
import { TopologyViewPicker } from "./TopologyViewPicker";

/**
 * Host for the topology views. It owns the facts (the canvas model, the
 * containment tree, the focused resource) and the shared navigation state, then
 * hands them to whichever view the registry resolves — it never renders a canvas
 * itself, and knows about no view by name.
 *
 * There is ONE navigation axis: the focus path. It designates the node whose
 * canvas is on screen, and the view is resolved for THAT node — so descending
 * onto a kind that declares its own topology lands on that kind's canvas without
 * leaving the module's tree, and the breadcrumb above it is still the way back.
 * The breadcrumb is the host's for the same reason the module bar is: "where am
 * I" is true of every view, including ones nobody has written yet.
 */
export function TopologyView({
  readOnly,
  viewData,
  registry,
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

  // Same overview model for both module roots; a Library has no `targets`.
  const model = useMemo<AppCanvasModel | null>(() => {
    if (rootKind?.topology !== MODULE_OVERVIEW_TOPOLOGY || !registry) return null;
    const targets = viewData.manifest.kind === "Application" ? viewData.manifest.targets : [];
    return buildApplicationCanvasModel(viewData, registry, targets);
  }, [rootKind, registry, viewData]);

  const tree = useMemo(() => (model ? buildContainmentTree(model) : null), [model]);

  // The stored path is re-resolved against the current tree on every pass, so an
  // edit that removes a link degrades to the deepest level that still exists
  // instead of leaving a view rendering an interior nothing reaches.
  const focusPath = useMemo(
    () => (tree ? resolveFocusPath(tree, topology.focusPath) : []),
    [tree, topology.focusPath],
  );

  // A request from another tab names a resource and not a route, so it is
  // resolved here — the only place the tree exists. A name nothing reaches
  // lands at the root: taking a route is what CLEARS the request, so a request
  // that resolved to nothing has to take one anyway or it re-fires on every
  // pass and drags the user back out of wherever they went next.
  const onFocusPath = topology.onFocusPath;
  const focusRequest = topology.focusRequest;
  useEffect(() => {
    if (!focusRequest || !tree) return;
    onFocusPath(findPathTo(tree, focusRequest) ?? []);
  }, [focusRequest, tree, onFocusPath]);

  // Everything below follows the FOCUS, not a second navigation axis: which
  // resource's canvas is on screen, which views apply to it, and what the
  // detail panel's field form is scoped to.
  const focusedResource =
    tree && focusPath.length
      ? (viewData.manifest.resources.find((r) => r.name === focusedId(tree, focusPath)) ?? root)
      : root;
  const focusedKind = focusedResource ? (viewData.kinds.get(focusedResource.kind) ?? null) : null;

  const ctx = useMemo<TopologyViewContext>(
    () => ({
      kind: focusedKind
        ? {
            fullKind: focusedKind.fullKind,
            capability: focusedKind.capability,
            topology: focusedKind.topology,
          }
        : null,
      hasSteps: !!focusedKind?.schema && !!getStepSchema(focusedKind.schema),
      hasEntries: !!focusedKind?.schema && !!entryListOf(focusedKind.schema),
      isModuleRoot: !!focusedResource && isModuleRootKind(focusedResource.kind),
      hasInterior: !!tree && childCountOf(tree, focusedId(tree, focusPath)) > 0,
    }),
    [focusedKind, focusedResource, tree, focusPath],
  );

  /** Navigation by NAME — the host resolves the route. */
  const onFocusResource = useCallback(
    (name: string) => {
      if (!tree) return;
      const path = findPathTo(tree, name);
      if (path) onFocusPath(path);
    },
    [tree, onFocusPath],
  );

  /** Whether focusing `name` would show more than the panel already does. Asked
   *  of the registry, so the answer cannot drift from what focusing resolves. */
  const canFocus = useCallback(
    (name: string) => {
      if (!tree || !tree.nodeById.has(name)) return false;
      const resource = viewData.manifest.resources.find((r) => r.name === name);
      const kind = resource ? viewData.kinds.get(resource.kind) : undefined;
      return worthFocusing({
        kind: kind
          ? { fullKind: kind.fullKind, capability: kind.capability, topology: kind.topology }
          : null,
        hasSteps: !!kind?.schema && !!getStepSchema(kind.schema),
        hasEntries: !!kind?.schema && !!entryListOf(kind.schema),
        isModuleRoot: !!resource && isModuleRootKind(resource.kind),
        hasInterior: childCountOf(tree, name) > 0,
      });
    },
    [tree, viewData],
  );

  const choiceKey = useMemo(() => viewChoiceKey(ctx), [ctx]);
  const views = useMemo(() => candidateViews(ctx), [ctx]);
  const view = useMemo(
    () => resolveView(ctx, topology.viewIdByChoiceKey[choiceKey]),
    [ctx, topology.viewIdByChoiceKey, choiceKey],
  );

  const onViewState = topology.onViewState;
  const viewId = view?.id;
  const onStateChange = useCallback(
    (next: unknown) => {
      if (viewId) onViewState(viewId, next);
    },
    [onViewState, viewId],
  );

  // Viewport keys are scoped by view: two views lay the same module out
  // differently, so restoring one's pan/zoom into the other drops the user into
  // empty space.
  const hostViewportFor = topology.viewportFor;
  const hostViewportChange = topology.onViewportChange;
  const viewportFor = useCallback(
    (key: string) => hostViewportFor(`${viewId ?? ""}#${key}`),
    [hostViewportFor, viewId],
  );
  const onViewportChange = useCallback<TopologyViewProps["onViewportChange"]>(
    (key, viewport) => hostViewportChange(`${viewId ?? ""}#${key}`, viewport),
    [hostViewportChange, viewId],
  );

  const viewProps: TopologyViewProps | null =
    focusedResource && focusedKind?.schema
      ? {
          tree,
          model,
          viewData,
          registry,
          refResolver: registry,
          resource: focusedResource,
          schema: focusedKind.schema,
          resolvedResources,
          typeKinds,
          focusPath,
          onFocusPath,
          onFocusResource,
          canFocus,
          selectedResource,
          selection,
          state: view ? topology.viewState[view.id] : undefined,
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
          onBackgroundClick: onClearSelection,
        }
      : null;

  const canvas =
    view && viewProps ? (
      <view.Component {...viewProps} />
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
  // Module chrome, not view content: what a module declares is true whichever
  // canvas is showing, and none of it is graph data — `imports`, `variables`,
  // `secrets`, `ports` and `exports` reference nothing and are referenced by
  // nothing, so no edge carries them and no node can hold them.
  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      {/* One column, two occupants, because it is one question — what is
          DECLARED here, beside the canvas showing what RUNS. At the root the
          answer is the module's own blocks (`imports`, `variables`, `secrets`,
          `ports`, `exports`); below it, the focused resource's own properties.
          The root keeps a bespoke bar rather than the generic rail because its
          rows carry affordances no schema describes — version upgrades, the
          add-import flow, per-environment values.

          The rail lists whatever the active view does not render, which is why
          it disappears beside the form view rather than being hidden by a rule
          of its own: that view consumes every property. */}
      {focusPath.length === 0 ? (
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
      ) : focusedResource && focusedKind?.schema ? (
        <PropertyRail
          resource={focusedResource}
          schema={focusedKind.schema}
          // What the active view renders, so the rail lists the rest — and
          // renders nothing at all beside the form view, which consumes every
          // property. Asked of the view rather than guessed from an annotation:
          // a field no view claims has to stay reachable somewhere.
          consumed={consumedFields(view, focusedKind.schema)}
          selection={selection}
          onSelect={onSelect}
        />
      ) : null}
      {/* `min-w-0` so an oversized canvas clips rather than pushing the row
          wider; the floor that keeps the content from being squeezed to nothing
          is the detail panel's `flex-1` cap, not a width here — a hard min on
          this column would overflow a narrow window into `overflow-hidden` and
          cut the panel off entirely. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <PreviewNotice />
        <div className="relative flex min-h-0 flex-1">
          {canvas}
          {/* Host chrome, not a view's: the breadcrumb is the way out of a
              focus, and a focus is the one navigation fact every view shares —
              including the kind-declared canvases, which know nothing about the
              tree they are now reachable inside. */}
          {tree && focusPath.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
              <div className="pointer-events-auto">
                <Breadcrumb tree={tree} focusPath={focusPath} onFocusPath={onFocusPath} />
              </div>
            </div>
          )}
          {view && views.length > 1 && (
            <div className="absolute right-2 top-2 z-10">
              <TopologyViewPicker
                views={views}
                activeId={view.id}
                onPick={(id) => topology.onPickView(choiceKey, id)}
              />
            </div>
          )}
        </div>
      </div>
      <DetailPanel
        selectedResource={selectedResource}
        selection={selection}
        // What the canvas above actually rendered, so the panel does not draw
        // it a second time. Null when no view resolved — then the canvas is the
        // "select a resource" placeholder and a peek is the only thing on screen.
        canvasResource={
          view && viewProps && focusedResource
            ? { kind: focusedResource.kind, name: focusedResource.name }
            : null
        }
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

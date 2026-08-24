import type { AnalysisRegistry } from "@telorun/analyzer";
import type { ComponentType } from "react";
import type { CanvasViewport, ModuleViewData, ParsedResource, Selection } from "../../../model";
import type { RefResolver } from "../../resource-schema-form/ref-candidates";
import type { ResolvedResourceOption, TypeKindOption } from "../../resource-schema-form/types";
import type { AppCanvasModel, GraphNode, RefWrite } from "./application-canvas-model";
import type { ContainmentTree, NodeId } from "./containment";

/**
 * The contract every topology view is handed. There are meant to be many views,
 * so the shape of this type is the thing that decides whether adding one is a
 * local change or an edit to shared code.
 *
 * The rule: **these props carry only what is meaningful to EVERY view. Anything
 * one view needs is that view's own state.** That is why the shared navigation
 * surface is `focusPath` and nothing more — a path is the one thing any view can
 * interpret (a drill view renders that node's interior, a nested view expands
 * that chain, an outline scrolls to it, a radial view centres it). A richer
 * shared state — an expansion set, say — would be one view's model imposed on
 * the rest, which is the mode flag this design exists to avoid; a view derives
 * its own from `focusPath` and keeps it in `state`.
 *
 * `state` / `onStateChange` are the escape hatch that keeps the rule payable:
 * an opaque bag the host persists per view id and never reads. Adding a view
 * touches no type here.
 */
export interface TopologyViewProps {
  /** Containment relation over the module. Null until the first analysis pass
   *  completes, or when the focused resource is not the module root. */
  tree: ContainmentTree | null;
  /** Module-wide canvas model the tree indexes into. Null with `tree`. */
  model: AppCanvasModel | null;

  viewData: ModuleViewData;
  registry: AnalysisRegistry | null;
  /** Ref-candidate resolver — the narrow slice the schema form needs. */
  refResolver: RefResolver | null;

  /** The resource whose canvas this is: the module root for the module-wide
   *  views, otherwise whatever the host navigated to. */
  resource: ParsedResource;
  /** `resource`'s kind schema. */
  schema: Record<string, unknown>;
  /** Every resource in the module, for pickers. */
  resolvedResources: ResolvedResourceOption[];
  /** Imported `Telo.Type` kinds offered for inline type fields. */
  typeKinds: TypeKindOption[];

  /** Shared navigation: node names below the tree root. Empty is the root. */
  focusPath: NodeId[];
  onFocusPath: (path: NodeId[]) => void;
  /**
   * Navigate to a resource NAMED rather than routed to — what a list row has.
   * The host resolves the route (see `findPathTo`), because a view that lists
   * resources knows the name and not the way there.
   */
  onFocusResource: (name: string) => void;
  /**
   * Whether navigating into `name` would show anything the detail panel does
   * not already show — i.e. whether the focus offers a view beyond the bare
   * field form. A row with no interior and no kind-declared canvas is a leaf,
   * and a click that replaced the canvas with the same form the panel is
   * already rendering would be a navigation that lost the reader their place
   * for nothing.
   */
  canFocus: (name: string) => boolean;

  selectedResource: { kind: string; name: string } | null;
  selection: Selection | null;

  /** Opaque per-view state, persisted by the host under this view's id. */
  state: unknown;
  onStateChange: (next: unknown) => void;

  /** Pan/zoom, keyed by the view — different views lay a module out
   *  differently, so restoring one view's viewport into another drops the user
   *  into empty space. A view passes whatever further key it needs (its focus
   *  path, its expansion signature). */
  viewportFor: (key: string) => CanvasViewport | null;
  onViewportChange: (key: string, viewport: CanvasViewport) => void;

  onSelectResource: (kind: string, name: string) => void;
  onSelect: (selection: Selection) => void;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  /** Creates a resource of `createKind` and writes `buildFields(newName)` back
   *  to `target` in one workspace mutation — what a ref slot offers when its
   *  kind has no instance yet. Required: a picker offers its create entries from
   *  the registry alone, so a host without a handler would let the marker value
   *  reach the manifest. */
  onCreateAndLink: (
    target: { kind: string; name: string },
    createKind: string,
    buildFields: (newName: string) => Record<string, unknown>,
  ) => void;
  onDeleteResource?: (kind: string, name: string) => void;
  onWriteRef?: (writes: RefWrite[]) => void;
  /** Reorders one item of a sequence field on a resource. Optional for the same
   *  reason `onWriteRef` is: it is an operation only some views can perform, not
   *  a fact every view is owed. */
  onMoveField?: (
    target: { kind: string; name: string },
    pointer: string,
    toIndex: number,
  ) => void;
  /** Moves one item of a sequence field into a different sequence — a step
   *  dragged between branches. Optional with `onMoveField`. */
  onRelocateField?: (
    target: { kind: string; name: string },
    pointer: string,
    toPointer: string,
    toIndex: number,
  ) => void;
  /** Removes one item of a sequence field. Optional with `onMoveField`. */
  onRemoveField?: (target: { kind: string; name: string }, pointer: string) => void;
  onCreateResource?: () => void;
  onBackgroundClick: () => void;
  /** Suppresses a view's own header where the host already renders one (the
   *  detail-panel peek). */
  hideHeader?: boolean;
}

/**
 * Resources a view does not draw, as a rail beside the canvas.
 *
 * NOTHING RENDERS THIS TODAY. The host's rail listed the ambient providers and
 * types, which the root level already lists as sections of itself — so beside
 * that level it said everything twice, and below it the reader was one
 * breadcrumb click from the level that says it once. {@link ResourceRail} is
 * kept for the next surface that needs a column of resources; this is the shape
 * it takes.
 */
export interface RailSection {
  id: string;
  title: string;
  items: GraphNode[];
}

/**
 * What a descriptor's `supports` is asked about — always the node the focus path
 * designates, never a second navigation axis.
 *
 * The focus resolving the view is what makes the kind-declared canvases (Routes,
 * Steps) reachable at depth: descending onto a `Run.Sequence` offers ITS view
 * with the breadcrumb still above it, instead of leaving the topology session to
 * re-root the canvas somewhere else.
 */
export interface TopologyViewContext {
  /** The focused resource's kind, or null when its definition is unresolved. */
  kind: { fullKind: string; capability?: string; topology?: string } | null;
  /**
   * The focused kind carries a step body — it declares a field annotated
   * `x-telo-topology-role: steps`.
   *
   * A derived FACT rather than the schema itself, so `supports` stays a cheap
   * predicate over plain data and no descriptor learns to walk a schema. It is
   * on the context rather than read off `kind.topology` because a step body is a
   * shared manifest fragment now: ANY kind may carry one (`Sql.Transaction`, a
   * durable workflow), while `topology: Sequence` is a per-kind opt-in that only
   * the kinds written before the fragment existed declare.
   */
  hasSteps: boolean;
  /**
   * The focused kind carries an ORDERED attachment list — a field annotated
   * `x-telo-topology-role: entries`.
   *
   * Beside {@link hasSteps} rather than folded into it: both are ordered arrays
   * the containment views would otherwise draw as unordered nodes, but a step
   * has a grammar (a closed set of control-flow variants) and an entry has only
   * whatever the kind declared its items to be, so they are read by different
   * models and rendered by different views.
   */
  hasEntries: boolean;
  /** True at the tree root — the synthesized module root. */
  isModuleRoot: boolean;
  /** The focused node has children in the containment relation. A view that
   *  draws an interior has nothing to draw without one, so this is what keeps a
   *  leaf from offering a canvas of one lonely node. */
  hasInterior: boolean;
}

/**
 * One topology view. Views are separate components, never modes of one: a mode
 * flag makes the seventh view an edit to a shared union, and every view's
 * peculiarities accumulate in one file.
 *
 * `supports` is also what replaced the kind-topology `if` chain the canvas
 * picker used to be. That chain was already "candidate set → pick one" with a
 * candidate set of size one; making it a filter means there is ONE dispatcher
 * rather than a kind-declared canvas beside a user-chosen view with nothing to
 * say which wins.
 */
export interface TopologyViewDescriptor {
  /** Stable — keys the remembered choice, the per-view state bag and the
   *  viewport. Never derive it from the label. */
  id: string;
  label: string;
  /** One-line explanation, shown on the view picker. */
  description: string;
  Component: ComponentType<TopologyViewProps>;
  supports: (ctx: TopologyViewContext) => boolean;
  /**
   * Which of the focused kind's own properties this view RENDERS.
   *
   * The property rail lists everything else, so this is what keeps one field
   * from being edited in two places — and, more importantly, what keeps one
   * from being editable in NEITHER. The rail used to exclude any field carrying
   * an `x-telo-topology-role`, which is a guess that a view is drawing it: a
   * kind annotating an array no view claims would have had that field vanish
   * from the rail and never appear on a canvas.
   *
   * Declared by the view because the view is what knows. Absent means "renders
   * none of them by name" — right for the containment views, which draw the
   * reference graph rather than any particular field.
   */
  consumes?: (schema: Record<string, unknown>) => readonly string[];
}

/**
 * The navigation + persistence state the host owns on behalf of whichever view
 * is active. Bundled into one prop because it is one concern — where the user is
 * and what they picked — and because spreading eight fields across `ViewProps`
 * would put topology detail in front of every other view in the editor.
 *
 * The view choice lives in settings rather than per module: a preference is an
 * answer to "which of these views do I want", and answering it once per module
 * is a chore, not a feature. Focus path and per-view state are per module and
 * in-memory, matching `viewportByModule` — they describe where you were, which
 * is worth keeping across a tab switch and not worth restoring across a reload
 * of a workspace that may have changed underneath it.
 */
export interface TopologyHostState {
  focusPath: NodeId[];
  onFocusPath: (path: NodeId[]) => void;
  /**
   * A resource another tab asked to navigate to, still un-routed.
   *
   * Only the topology host has the containment tree, so a caller outside it can
   * name a resource but cannot say how to get there; the host resolves it to a
   * focus path on the next pass and `onFocusPath` clears it. A request that
   * resolves to nothing is dropped rather than left pending — the resource may
   * simply not be in this module's graph.
   */
  focusRequest: string | null;
  /** Remembered view per candidate-set key — see `viewChoiceKey`. */
  viewIdByChoiceKey: Record<string, string>;
  onPickView: (choiceKey: string, viewId: string) => void;
  /** Opaque per-view state, keyed by view id. */
  viewState: Record<string, unknown>;
  onViewState: (viewId: string, next: unknown) => void;
  viewportFor: (key: string) => CanvasViewport | null;
  onViewportChange: (key: string, viewport: CanvasViewport) => void;
}

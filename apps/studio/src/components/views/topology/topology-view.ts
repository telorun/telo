import type { AnalysisRegistry, ModuleGraph } from "@telorun/analyzer";
import type { ComponentType } from "react";
import type { CanvasViewport, ModuleViewData, ParsedResource, Selection } from "../../../model";
import type { RefResolver } from "../../resource-schema-form/ref-candidates";
import type { ResolvedResourceOption, TypeKindOption } from "../../resource-schema-form/types";
import type { GraphNode, RefWrite } from "./application-canvas-model";

/**
 * The contract a canvas is handed — the module graph on the topology tab, and
 * the kind-declared body editors (Routes, Steps, Entries, Fields) the detail
 * panel renders for whatever is selected.
 *
 * **There is no navigation in it.** A canvas used to be resolved per FOCUS, so
 * selecting a route re-rooted the whole surface onto that route's own editor and
 * the graph vanished. Selecting a thing is a request to SEE it, which the panel
 * answers beside the canvas — so a focus path, a containment tree and a
 * "can I focus this" predicate are all gone, and with them the only way the
 * canvas could be replaced by something the reader did not ask for.
 *
 * `state` / `onStateChange` are an opaque bag the host persists per view id and
 * never reads.
 */
export interface TopologyViewProps {
  /** The module graph the canvas draws — see `ViewProps.moduleGraph`. */
  moduleGraph: ModuleGraph | null;
  /** An imported module's own graph, by module name — see `ViewProps`. */
  moduleGraphFor: (moduleName: string) => ModuleGraph | null;
  /** Whether that module's files can be edited here — see `ViewProps`. */
  isEditableModule: (moduleName: string) => boolean;

  viewData: ModuleViewData;
  registry: AnalysisRegistry | null;
  /** Ref-candidate resolver — the narrow slice the schema form needs. */
  refResolver: RefResolver | null;

  /** The resource whose canvas this is. */
  resource: ParsedResource;
  /** `resource`'s kind schema. */
  schema: Record<string, unknown>;
  /** Every resource in the module, for pickers. */
  resolvedResources: ResolvedResourceOption[];
  /** Imported `Telo.Type` kinds offered for inline type fields. */
  typeKinds: TypeKindOption[];

  /** Opaque per-view state, persisted by the host under this view's id. */
  state: unknown;
  onStateChange: (next: unknown) => void;

  /** Pan/zoom, keyed by whatever further key the view needs (its expansion
   *  signature, say). */
  viewportFor: (key: string) => CanvasViewport | null;
  onViewportChange: (key: string, viewport: CanvasViewport) => void;

  selectedResource: { kind: string; name: string } | null;
  selection: Selection | null;

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
  /** Moves the resource declared INLINE at `pointer` into its own document under
   *  `name`, leaving a reference behind. Its own operation, not a field write —
   *  it adds a document and rewrites a slot in ONE mutation, and a half-applied
   *  one is either a resource declared twice or a slot pointing at nothing. */
  onExtractInline?: (
    host: { kind: string; name: string },
    pointer: string,
    name: string,
  ) => void;
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
  /** Retained so the host can clear a pending request; the canvas no longer
   *  navigates, so nothing else reads it. */
  focusPath: string[];
  onFocusPath: (path: string[]) => void;
  /**
   * A resource another tab asked to show, still unhandled.
   *
   * It is a request to LOOK at that resource, which the host turns into a
   * selection — the graph draws every resource, so there is nowhere to navigate
   * to. Cleared on the next pass, or it re-fires and drags the reader back here
   * after they have moved on.
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

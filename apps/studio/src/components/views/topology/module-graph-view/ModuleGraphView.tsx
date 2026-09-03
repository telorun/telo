import {
  isAmbientHold,
  isOrderedRow,
  isUnwired,
  type GraphEdge,
  type GraphNode,
  type GraphPort,
  type GraphRow,
  type ModuleGraph,
} from "@telorun/analyzer";
import {
  Background,
  ReactFlow,
  type Edge,
  type EdgeChange,
  type Node as FlowNode,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isRecord } from "../../../../lib/utils";
import { readConcretePath } from "../../../../lib/concrete-path";
import { resolveRef } from "../../../../schema-utils";
import type { RefWrite } from "../application-canvas-model";
import type { TopologyViewProps } from "../topology-view";
import { isEntryPoint } from "./placement";
import { isImportedInstance, nodesReaching, offCanvasNodes } from "./off-canvas";
import { resolveMirrors } from "./mirrors";
import { propertyOf, propKey, resolveVisibility } from "./collapsible";
import type { IsOpen } from "./box-geometry";
import { ownershipIndex } from "./ownership";
import { isRowDrawn } from "./row-tree";
import { isPickerPort, pickerCandidates } from "./picker-port";
import { applyEdgeSelection } from "./edge-selection";
import { layoutWithElk, type ModuleGraphLayout } from "./elk-layout";
import { anchorShift, defaultAnchor } from "./viewport-anchor";
import { moduleGraphEdgeTypes, type RoutedEdgeData } from "./RoutedEdge";
import { jsonPointer } from "./field-pointer";
import { entrySchemaFor } from "./entry-schema";
import { ModuleDrawer } from "./ModuleDrawer";
import { drawerGroups, kindPlaneIsSoleContent } from "./drawer-groups";
import {
  handleId,
  moduleGraphNodeTypes,
  type GraphBoxData,
  type ScreenPoint,
} from "./graph-nodes";
import {
  referenceableTargets,
  referenceName,
  siteOfHandle,
  siteRefs,
  spellingFor,
  type WireSite,
} from "./wire";
import { ExtractInlineDialog } from "../../../ExtractInlineDialog";
import { WireMenu } from "./WireMenu";
import { suggestedResourceName } from "../../../../resource-naming";

/**
 * The module graph, as one canvas.
 *
 * Every declaration is a box; every ordered entry inside one is a row; every
 * reference leaving a slot is an edge classed by what happens at it. The three
 * columns answer the question a reader opens the tab with — where does work
 * enter and what does it flow through — and nothing here picks one relation to
 * draw and hides the rest: flow is solid, a hold is thin, a data read is drawn
 * when the resource it concerns is selected, and a hold on something that is
 * only ever HELD collapses to the name in its slot's picker, with the target
 * itself moved to a drawer rather than left as a box no line reaches.
 *
 * Layout and edge routing are ELK's (see `elk-layout.ts`), solved together over
 * fixed ports: an edge leaves the exact row it was declared on, and the target
 * is placed to suit. Nothing is dragged and nothing is persisted — the view
 * state is which boxes are open, which libraries are open, and which kind is
 * highlighted.
 */

/**
 * One viewport per module, not per expansion.
 *
 * It used to be keyed by the set of open branches, which meant every toggle
 * restored a different pan — and, because the key was also the flow's React
 * key, tore the canvas down and re-fitted it. Both together are what made a
 * collapse feel like the screen jumping.
 */
const VIEWPORT_KEY = "graph";

interface ViewState {
  /** Branches the reader has PUT AWAY, as `<node id><property>` keys. Stored as
   *  the exception rather than the rule: a branch's rows are its content — the
   *  routes, the steps, the boot order — so hiding them by default shows a
   *  canvas of summaries and makes opening every branch the price of reading the
   *  module. */
  collapsed?: string[];
  kindsOpen?: boolean;
  kind?: string | null;
}

/** Titles for a kind's ref slots, walked from the kind schema. Labels are the
 *  view's, so this is where a slot's declared `title` is read — the projection
 *  emits the path and stays out of presentation. */
function portTitlesFor(
  schema: Record<string, unknown> | undefined,
  slots: string[],
): Record<string, string> {
  if (!schema) return {};
  const out: Record<string, string> = {};
  for (const slot of slots) {
    let node: unknown = schema;
    let title: string | undefined;
    for (const rawSeg of slot.split(".")) {
      const seg = rawSeg.replace(/(\[\]|\{\})+$/g, "");
      const container = resolveRef(node, schema);
      const props =
        isRecord(container) && isRecord(container.properties) ? container.properties : undefined;
      const propSchema = props ? resolveRef(props[seg], schema) : undefined;
      if (isRecord(propSchema) && typeof propSchema.title === "string") title = propSchema.title;
      node = isRecord(propSchema)
        ? rawSeg.endsWith("[]")
          ? resolveRef(propSchema.items, schema)
          : rawSeg.endsWith("{}")
            ? resolveRef(propSchema.additionalProperties, schema)
            : propSchema
        : undefined;
    }
    if (title) out[slot] = title;
  }
  return out;
}

/**
 * How an edge is drawn: what happens at the site, not who declared it.
 *
 * A SELECTED edge is restyled here rather than left to xyflow's stylesheet: the
 * default selected-edge rule sets `stroke` in CSS, and an inline `style` — which
 * every edge here has, because its class is its colour — wins over it. So
 * selection was applied and invisible, which reads as selection not working.
 */
function edgeStyle(
  edge: GraphEdge,
  selected: boolean,
): { stroke: string; strokeWidth: number; strokeDasharray?: string } {
  const base = ((): { stroke: string; strokeWidth: number; strokeDasharray?: string } => {
    if (edge.class === "data") return { stroke: "#8b5cf6", strokeWidth: 1, strokeDasharray: "2 3" };
    if (edge.boot) return { stroke: "#6366f1", strokeWidth: 1.6 };
    if (edge.class === "holds") return { stroke: "#a1a1aa", strokeWidth: 1 };
    if (edge.use.includes("detached"))
      return { stroke: "#0ea5e9", strokeWidth: 1.4, strokeDasharray: "4 3" };
    if (edge.use.includes("trigger.inbound")) return { stroke: "#10b981", strokeWidth: 1.4 };
    return { stroke: "#52525b", strokeWidth: 1.4 };
  })();
  return selected
    ? { ...base, stroke: "#f43f5e", strokeWidth: base.strokeWidth + 1.6 }
    : base;
}

export function ModuleGraphView({
  moduleGraph,
  isEditableModule,
  registry,
  viewData,
  selectedResource,
  state,
  onStateChange,
  onSelect,
  onSelectResource,
  onUpdateResource,
  onMoveField,
  onRemoveField,
  onWriteRef,
  onExtractInline,
  resolvedResources,
  refResolver,
  onBackgroundClick,
  viewportFor,
  onViewportChange,
}: TopologyViewProps) {
  /**
   * Which edges are selected.
   *
   * Local, not in the persisted view state: a selection is where the reader's
   * attention is right now, and restoring one across a tab switch would put a
   * delete gesture on something they last touched an hour ago.
   */
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
  /** Why the last layout could not be solved, when it could not. */
  const [layoutError, setLayoutError] = useState<string | null>(null);

  /**
   * A slot the reader has asked to fill, and where they asked — the menu opens
   * at the gesture, so the `+` beside a socket and a drag let go in empty space
   * both answer where they were made.
   *
   * Local rather than persisted view state: it is a gesture in flight, and
   * restoring one across a tab switch would reopen a menu over a slot the reader
   * last touched an hour ago.
   */
  const [wiring, setWiring] = useState<{ site: WireSite; at: ScreenPoint } | null>(null);

  const view = (state as ViewState | undefined) ?? {};
  const collapsed = useMemo(() => new Set(view.collapsed ?? []), [view.collapsed]);
  const isOpen = useCallback(
    (nodeId: string, property: string) => !collapsed.has(propKey(nodeId, property)),
    [collapsed],
  );
  const isCollapsed = useCallback(
    (nodeId: string, property: string) => collapsed.has(propKey(nodeId, property)),
    [collapsed],
  );
  const selectedKind = view.kind ?? null;

  const patch = useCallback(
    (next: Partial<ViewState>) => onStateChange({ ...view, ...next } satisfies ViewState),
    [onStateChange, view],
  );

  /** The box the reader last acted on — held still across the re-layout its
   *  action causes. */
  const anchor = useRef<string | null>(null);

  const toggleProperty = useCallback(
    (nodeId: string, property: string) => {
      anchor.current = nodeId;
      const key = propKey(nodeId, property);
      const next = new Set(collapsed);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      patch({ collapsed: [...next] });
    },
    [collapsed, patch],
  );

  const ownedBy = useMemo(
    () => (moduleGraph ? ownershipIndex(moduleGraph) : new Map()),
    [moduleGraph],
  );

  const selectedId = useMemo(
    () =>
      moduleGraph?.nodes.find(
        (n) => n.name === selectedResource?.name && n.kind === selectedResource?.kind,
      )?.id,
    [moduleGraph, selectedResource],
  );

  /**
   * The edges the canvas draws, and the handle each leaves from.
   *
   * Decided before layout because the layout ROUTES them: an engine solving for
   * position and route together has to be told which lines exist and where they
   * start, and a second opinion computed afterwards in the renderer would be a
   * different set from the one that was solved.
   */
  const drawing = useMemo(() => {
    if (!moduleGraph) {
      return { drawn: [] as GraphEdge[], collapsedBySource: new Map(), heldBy: new Map() };
    }
    const collapsedBySource = new Map<string, Map<string, string[]>>();
    const heldBy = new Map<string, number>();
    const drawn: GraphEdge[] = [];
    for (const edge of moduleGraph.edges) {
      if (edge.class === "shape") continue;
      // A data read is a real dependency and a noisy one: it is drawn when the
      // resource it concerns is selected, which is when a reader is asking.
      if (edge.class === "data") {
        if (selectedId && (edge.from === selectedId || edge.to === selectedId)) drawn.push(edge);
        continue;
      }
      // Two reasons an edge is summarised at its source instead of drawn, and
      // both end the same way: the target is not a box, so a line to it would
      // point at nothing. An ambient hold is one; a reference across an import
      // boundary is the other — see `off-canvas.ts` for why each leaves.
      const target = edge.to ? moduleGraph.nodeById(edge.to) : undefined;
      if (isAmbientHold(edge, moduleGraph) || (target && isImportedInstance(target))) {
        const slots = collapsedBySource.get(edge.from) ?? new Map<string, string[]>();
        slots.set(edge.slot, [...(slots.get(edge.slot) ?? []), edge.toName]);
        collapsedBySource.set(edge.from, slots);
        if (edge.to) heldBy.set(edge.to, (heldBy.get(edge.to) ?? 0) + 1);
        continue;
      }
      drawn.push(edge);
    }
    return { drawn, collapsedBySource, heldBy };
  }, [moduleGraph, selectedId]);

  /** What survives the collapsed branches — see `resolveVisibility`. */
  const visible = useMemo(
    () =>
      moduleGraph
        ? resolveVisibility({ graph: moduleGraph, drawn: drawing.drawn, isCollapsed })
        : { nodes: new Set<string>(), edges: [] as GraphEdge[] },
    [moduleGraph, drawing, isCollapsed],
  );

  /**
   * What is a drawer row rather than a box — see `off-canvas.ts`. Split after
   * visibility, because for an ambient hold the test is whether a DRAWN edge
   * touches it: a provider control genuinely transfers to keeps its box, and the
   * line to it keeps something to point at. An imported instance needs no such
   * test and leaves either way.
   */
  const offCanvas = useMemo(
    () => (moduleGraph ? offCanvasNodes(moduleGraph, visible.edges) : null),
    [moduleGraph, visible],
  );

  /**
   * How many boxes reach each drawer row — the fan-in the canvas no longer
   * draws.
   *
   * A summarised edge is counted where it was summarised, which is the exact
   * fan-in for anything reached only that way. Anything else is counted off the
   * graph, since a declaration can leave the canvas while edges to it are still
   * in the drawn set (a provider selected into a data read), and a row saying
   * "nothing reaches this" about something half the module holds is worse than
   * no count at all.
   */
  const drawerHeldBy = useMemo(() => {
    const counts = new Map(drawing.heldBy);
    if (!moduleGraph || !offCanvas) return counts;
    for (const id of offCanvas.ids) {
      if (counts.has(id)) continue;
      counts.set(id, new Set(moduleGraph.edgesTo(id).map((edge) => edge.from)).size);
    }
    return counts;
  }, [moduleGraph, offCanvas, drawing]);

  /**
   * A shared resource drawn once, mirrored at every later call site.
   *
   * Computed after visibility and before layout, because it CHANGES the edge
   * set the solver is given: a mirrored edge points at its stand-in, so the
   * solver places that stand-in beside the row it leaves and there is no long
   * line left to route.
   */
  const mirrored = useMemo(
    () => (moduleGraph ? resolveMirrors(moduleGraph, visible.edges) : null),
    [moduleGraph, visible],
  );

  /** What the layout is given: the visible set less what moved to a drawer. */
  const placedIds = useMemo(() => {
    if (!offCanvas) return visible.nodes;
    return new Set([...visible.nodes].filter((id) => !offCanvas.ids.has(id)));
  }, [visible, offCanvas]);

  const sourcePathOf = useCallback(
    (edge: GraphEdge) => sourceHandlePath(moduleGraph, edge, isOpen),
    [moduleGraph, isOpen],
  );

  /**
   * Layout is ASYNC because the solver is. The previous result is kept on screen
   * while the next is computed — a canvas that blanked between edits would flash
   * on every keystroke — and a stale answer is discarded by generation, so a
   * slow solve cannot overwrite a newer one.
   */
  const [layout, setLayout] = useState<ModuleGraphLayout | null>(null);
  useEffect(() => {
    if (!moduleGraph) {
      setLayout(null);
      return;
    }
    let live = true;
    void layoutWithElk({
      graph: moduleGraph,
      isOpen,
      ownedBy,
      visible: placedIds,
      drawn: mirrored?.edges ?? visible.edges,
      extra: mirrored?.mirrors.map((m) => m.node) ?? [],
      sourcePathOf,
    })
      .then((next) => {
        if (live) {
          setLayout(next);
          setLayoutError(null);
        }
      })
      .catch((error: unknown) => {
        // A solver failure is not a reason to show a picture that is no longer
        // true. The previous layout stays — DELIBERATELY, and said so — while
        // the canvas reports that it is stale, because silently keeping it is
        // how a reader ends up reading a module that has moved on.
        if (live) setLayoutError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [moduleGraph, isOpen, ownedBy, visible, placedIds, mirrored, sourcePathOf]);

  /**
   * Append an empty entry to one of a box's ordered arrays.
   *
   * **It writes and stops there** — no panel, no selection change. Adding a
   * target is nearly always followed by wiring it to something, which is done
   * on the new row; opening a form over it instead takes the reader out of the
   * gesture they were in, and the row is one click away if they do want it.
   *
   * What a new entry must contain is the kind's business, so what is written is
   * empty and the ordinary diagnostics say so — the honest state of a route
   * someone has just started. The current value is read from the MANIFEST, not
   * from the rows: rows are a projection, and appending to a projection would
   * drop whatever the projection does not carry.
   */
  const addRow = useCallback(
    (node: GraphNode, array: string) => {
      const declared = viewData.manifest.resources.find(
        (r) => r.name === node.name && r.kind === node.kind,
      );
      if (!declared) return;
      const existing = declared.fields[array];
      const items = Array.isArray(existing) ? existing : [];
      onUpdateResource(node.kind, node.name, { ...declared.fields, [array]: [...items, {}] });
    },
    [viewData, onUpdateResource],
  );

  /**
   * What a picked slot offers.
   *
   * Memoized per CONSTRAINT rather than per slot: the same `Sql.Connection` is
   * held by every statement in the module, and expanding an abstract to its
   * implementations is a graph walk — asking once per box would run it dozens
   * of times per re-layout, at keystroke rate.
   */
  const pickerOptions = useMemo(() => {
    const cache = new Map<string, { candidates: string[]; createKinds: string[] }>();
    return (port: GraphPort) => {
      if (!moduleGraph || !refResolver) return { candidates: [], createKinds: [] };
      const key = port.refs.join("|");
      const hit = cache.get(key);
      if (hit) return hit;
      const kinds = new Set<string>();
      for (const ref of port.refs) {
        for (const kind of registry?.userFacingKindsForRef(ref) ?? []) kinds.add(kind);
      }
      const answer = {
        candidates: pickerCandidates(port, moduleGraph.nodes, refResolver),
        createKinds: [...kinds].sort(),
      };
      cache.set(key, answer);
      return answer;
    };
  }, [moduleGraph, refResolver, registry]);

  /** Edit a call's argument map in the detail panel, typed by what the target
   *  declares it takes — the same contract `telo check` validates the site
   *  against, so the form and the checker cannot disagree. */
  const editRowInputs = useCallback(
    (node: GraphNode, row: GraphRow) => {
      if (!row.inputs) return;
      const target = row.targetNode ? moduleGraph?.nodeById(row.targetNode) : undefined;
      const targetKind = target ? (target.canonicalKind ?? target.kind) : undefined;
      const schema =
        (targetKind ? registry?.inputTypeForKind(targetKind) : undefined) ??
        ({ type: "object", additionalProperties: true } as Record<string, unknown>);
      onSelect({
        resource: { kind: node.kind, name: node.name },
        pointer: jsonPointer(row.inputs),
        schema,
        celEval: "runtime",
      });
    },
    [moduleGraph, registry, onSelect],
  );

  /**
   * The schema of the ENTRY a row stands for — see `entry-schema.ts`.
   *
   * The module root is the one node whose schema does not come from the kind
   * table: the view projects a placeholder for it (`targets` is edited on the
   * canvas, so the projection declares it as a list of names), and the real
   * shape — the union a boot target actually is — is the kernel built-in the
   * registry holds. Every other kind's schema is the canonicalized one the panel
   * itself renders from, so an entry form and a resource form cannot disagree
   * about what a field is.
   */
  const entrySchemaOf = useCallback(
    (node: GraphNode, row: GraphRow) => {
      const schema = node.root
        ? (registry?.resolveDefinitionIn(node.kind, node.module)?.schema as
            | Record<string, unknown>
            | undefined)
        : viewData.kinds.get(node.canonicalKind ?? node.kind)?.schema;
      const declared = viewData.manifest.resources.find(
        (resource) => resource.kind === node.kind && resource.name === node.name,
      );
      return entrySchemaFor(schema, row.array, readConcretePath(declared?.fields, row.path));
    },
    [registry, viewData],
  );

  /**
   * What clicking a row shows in the panel beside the canvas.
   *
   * **A row IS an entry, and that is what it opens.** A boot target, a mount, a
   * route, a step is a line of its host's configuration, and it carries its own:
   * a guard, an argument map, a retry budget, a path and a method. Selecting the
   * host answered a question the reader did not ask — its whole body, with the
   * one line they clicked somewhere inside it — and selecting the RESOURCE at
   * the far end answered a different one, which its own box already answers.
   *
   * It SELECTS, never navigates: the canvas stays where it is.
   *
   * A DECLARATION written at the site is the same rule one level in: it has no
   * document of its own, so the panel opens at the site, typed by the kind
   * written there.
   *
   * A row that cannot be typed falls back to the HOST — an entry written as a
   * bare reference (nothing to configure, and the panel edits an object body),
   * and one whose shape the form cannot render in full. Showing the host is a
   * worse answer than the entry and a much better one than a blank panel.
   */
  const selectRow = useCallback(
    (node: GraphNode, row: GraphRow) => {
      if (row.kind !== "inline" || !row.declares) {
        const schema = entrySchemaOf(node, row);
        if (schema) {
          onSelect({
            resource: { kind: node.kind, name: node.name },
            pointer: jsonPointer(row.path),
            schema,
          });
          return;
        }
        onSelectResource(node.kind, node.name);
        return;
      }
      const schema = viewData.kinds.get(row.declares)?.schema;
      onSelect({
        resource: { kind: node.kind, name: node.name },
        pointer: jsonPointer(row.path),
        // An unresolved kind still opens: a free-form map is what the author
        // has, and refusing to open it would leave a typo uneditable here.
        schema: schema ?? { type: "object", additionalProperties: true },
      });
    },
    [entrySchemaOf, viewData, onSelect, onSelectResource],
  );

  /**
   * What the open wire picker offers: the names already declared that this site
   * would accept, then the kinds one could be created as.
   *
   * The SAME rule the drag and a picked slot's select use, so the three ways of
   * filling one slot cannot disagree about what fills it — and it is what keeps
   * an imported instance reachable now that it is a drawer row rather than a box
   * to drop onto. Per SITE, not per module: a boot target accepts a dozen kinds
   * in a real app while a connection slot accepts exactly one.
   */
  const wireOptions = useMemo(() => {
    if (!wiring || !moduleGraph || !refResolver) return undefined;
    const createKinds = new Set<string>();
    for (const ref of siteRefs(wiring.site)) {
      for (const kind of registry?.userFacingKindsForRef(ref) ?? []) createKinds.add(kind);
    }
    return {
      candidates: [
        ...new Set(
          referenceableTargets(wiring.site, moduleGraph.nodes, refResolver).map(referenceName),
        ),
      ].sort(),
      createKinds: [...createKinds].sort(),
    };
  }, [wiring, moduleGraph, refResolver, registry]);

  /**
   * Fill the open site with a name, or with a resource created for it.
   *
   * WHICH spelling the reference lands in follows from what was picked — a boot
   * target's bare entry takes a Runnable, its `invoke:` takes any Executable —
   * so a reader picks a resource and never a syntax. A choice no spelling
   * accepts is dropped rather than written somewhere it would fail: the picker
   * offered only what one of them takes, so there is nothing to report.
   */
  const fillWire = useCallback(
    (choice: { reference: string } | { createKind: string }) => {
      if (!wiring || !moduleGraph || !refResolver || !onWriteRef) return;
      const target =
        "reference" in choice
          ? moduleGraph.nodes.find((node) => referenceName(node) === choice.reference)
          : { kind: choice.createKind };
      const spelling = target ? spellingFor(wiring.site, target, refResolver) : undefined;
      if (spelling) {
        onWriteRef([
          {
            source: { kind: wiring.site.source.kind, name: wiring.site.source.name },
            concretePath: spelling.concretePath,
            target: "reference" in choice ? choice.reference : null,
            ...("createKind" in choice ? { createKind: choice.createKind } : {}),
          },
        ]);
      }
      setWiring(null);
    },
    [wiring, moduleGraph, refResolver, onWriteRef],
  );

  const { nodes, edges } = useMemo(() => {
    if (!moduleGraph || !layout) return { nodes: [] as FlowNode[], edges: [] as Edge[] };

    const { collapsedBySource, heldBy } = drawing;

    // Zones the selected box opens — its members get the region highlight,
    // which is what "inside this transaction" looks like when the members are
    // not contiguous on the canvas and no box can be drawn around them.
    const inZone = new Set<string>();
    const zonesByOwner = new Map<string, { site: string; attributes: Record<string, string> }[]>();
    for (const region of moduleGraph.regions) {
      if (region.kind !== "zone") continue;
      if (region.owner === selectedId) for (const member of region.members) inZone.add(member);
      zonesByOwner.set(region.owner, [
        ...(zonesByOwner.get(region.owner) ?? []),
        { site: region.site, attributes: { ...(region.attributes ?? {}) } },
      ]);
    }

    const kindInstances = new Set(
      selectedKind ? (moduleGraph.kinds.find((k) => k.id === selectedKind)?.instances ?? []) : [],
    );
    // Selecting a declaration in a drawer rings whatever reaches it — the ring
    // is what stands in for the line the canvas no longer draws. Read off EVERY
    // edge, not the drawn ones: the collapsed hold IS the relation being asked
    // about.
    const reaching = nodesReaching(moduleGraph, selectedId);
    const mirrorOf = new Map((mirrored?.mirrors ?? []).map((m) => [m.node.id, m.targetId] as const));

    const flowNodes: FlowNode[] = layout.placed.map((placed) => {
      const node = placed.node;
      const collapsed = [...(collapsedBySource.get(node.id) ?? new Map()).entries()].map(
        ([slot, targets]) => ({ slot, targets: targets as string[] }),
      );
      // The canonical kind first: an instance a library declared as
      // `kind: Self.WriteLine` is only in the kind table under the name its
      // owning module gives it.
      const schema = viewData.kinds.get(node.canonicalKind ?? node.kind)?.schema;
      const editable = !node.module || isEditableModule(node.module);
      // Ordered rows only: a declaration written at a dispatch site borrows its
      // host's array so it groups into the right branch, and counting it would
      // give the last real step a "move down" past a row that cannot move.
      const rowCountByArray: Record<string, number> = {};
      for (const row of node.rows) {
        if (!isOrderedRow(row)) continue;
        rowCountByArray[row.array] = (rowCountByArray[row.array] ?? 0) + 1;
      }
      const isMirror = mirrorOf.has(node.id);
      const data: GraphBoxData = {
        node,
        ...(isMirror ? { mirror: true } : {}),
        ...(mirrored?.fanIn.get(node.id) ? { fanIn: mirrored.fanIn.get(node.id) } : {}),
        depth: placed.depth,
        owned: (layout.ownedBy.get(node.id) ?? []).length,
        selected: selectedResource?.name === node.name && selectedResource?.kind === node.kind,
        portTitles: portTitlesFor(
          schema,
          node.ports.map((p) => p.slot),
        ),
        collapsedHolds: collapsed,
        ...(heldBy.get(node.id) ? { heldBy: heldBy.get(node.id) } : {}),
        ...(isUnwired(node, moduleGraph) ? { unwired: true } : {}),
        ...(isEntryPoint(node, moduleGraph) ? { entryPoint: true } : {}),
        ...(zonesByOwner.get(node.id) ? { zones: zonesByOwner.get(node.id) } : {}),
        ...(inZone.has(node.id) ? { inZone: true } : {}),
        ...(kindInstances.has(node.id) ||
        reaching.has(node.id) ||
        (selectedId && mirrorOf.get(node.id) === selectedId)
          ? { ofSelectedKind: true }
          : {}),
        ...(node.external && !editable ? { readOnly: true } : {}),
        isOpen: (property: string) => isOpen(node.id, property),
        onToggleProperty: (property: string) => toggleProperty(node.id, property),
        rowCountByArray,
        // Row editing is offered only where a write can land: a published
        // import's files are not the workspace's, so the controls are absent
        // rather than present-and-refusing.
        ...(editable && onMoveField
          ? {
              onMoveRow: (row: GraphRow, toIndex: number) =>
                onMoveField({ kind: node.kind, name: node.name }, jsonPointer(row.path), toIndex),
            }
          : {}),
        ...(editable && onRemoveField
          ? {
              onRemoveRow: (row: GraphRow) =>
                onRemoveField({ kind: node.kind, name: node.name }, jsonPointer(row.path)),
            }
          : {}),
        ...(editable ? { onEditRowInputs: (row: GraphRow) => editRowInputs(node, row) } : {}),
        // Offered from the DECLARED arrays, so a server with no mounts can be
        // given its first one — the rows are what exists, not what may exist.
        ...(editable && node.rowArrays.length > 0
          ? {
              onAddRow: (array: string) => addRow(node, array),
              arrayLabels: Object.fromEntries(
                node.rowArrays.map((a) => [
                  a.field,
                  portTitlesFor(schema, [a.field])[a.field] ?? a.field,
                ]),
              ),
            }
          : {}),
        ...(editable && onWriteRef ? { connectable: true } : {}),
        ...(editable && onWriteRef
          ? {
              // Emptying a slot is the same write whether it held a reference
              // or a declaration: the site goes back to unfilled. It is the
              // write deleting an edge already performs, offered where the slot
              // draws no edge to delete.
              onClearSlot: (concretePath: string) =>
                onWriteRef([
                  {
                    source: { kind: node.kind, name: node.name },
                    concretePath,
                    target: null,
                  },
                ]),
              onCreateAtSlot: (concretePath: string, at: ScreenPoint) => {
                const site = siteOfHandle(node, handleId(concretePath));
                // The site is looked up by HANDLE rather than trusted from the
                // caller, so what is offered is the slot's own — one rule for
                // the `+` and for the drag that ends in space.
                if (site) setWiring({ site, at });
              },
            }
          : {}),
        ...(editable && onExtractInline
          ? {
              onExtractInline: (concretePath: string, kind: string) =>
                setExtracting({
                  host: { kind: node.kind, name: node.name },
                  pointer: jsonPointer(concretePath),
                  kind,
                }),
            }
          : {}),
        pickerOptions,
        // A picked slot writes the same reference a drag does, through the same
        // path — so filling one by select and filling it by wire cannot land
        // differently. `createKind` rides the write, because creating the
        // resource and pointing at it must be ONE workspace mutation.
        ...(editable && onWriteRef
          ? {
              onPickRef: (concretePath: string, target: string | null) =>
                onWriteRef([
                  { source: { kind: node.kind, name: node.name }, concretePath, target },
                ]),
              onCreateRef: (concretePath: string, createKind: string) =>
                onWriteRef([
                  {
                    source: { kind: node.kind, name: node.name },
                    concretePath,
                    target: null,
                    createKind,
                  },
                ]),
            }
          : {}),
        onOpen: () => onSelectResource(node.kind, node.name),
        // A row click SELECTS — the panel shows this resource's body beside the
        // canvas. It used to navigate into the target, which replaced the whole
        // surface with that resource's editor: a click on a row is a request to
        // see the row, never to leave the picture it is in.
        //
        // A DECLARATION written at a dispatch site is the one row whose click
        // means something narrower: it has no document of its own, so the panel
        // is opened at the site itself, typed by the kind written there. That is
        // the only way to edit one without first giving it a name.
        onSelectRow: (row: GraphRow) => selectRow(node, row),
      };
      return {
        id: node.id,
        type: "box",
        deletable: false,
        // Only edges are selectable — a box is opened, not selected, and making
        // it selectable would mean maintaining node selection state for a
        // gesture that does nothing.
        selectable: false,
        position: { x: placed.x, y: placed.y },
        width: placed.width,
        height: placed.height,
        data: data as unknown as Record<string, unknown>,
        draggable: false,
        // An owned declaration is drawn inside the box that declares it, which
        // is what `parentId` means to xyflow: its position is relative, and it
        // moves and clips with its owner.
        ...(placed.parent ? { parentId: placed.parent, extent: "parent" as const } : {}),
      };
    });

    const flowEdges: Edge[] = (mirrored?.edges ?? visible.edges)
      .filter((e) => e.to && layout.byId.has(e.from) && layout.byId.has(e.to))
      .map((edge) => {
        const path = sourcePathOf(edge);
        const selected = selectedEdges.has(edge.id);
        const data: RoutedEdgeData = {
          ...(layout.routes.get(edge.id) ? { points: layout.routes.get(edge.id) } : {}),
          ...(edge.read ? { label: edge.read } : {}),
        };
        return {
          id: edge.id,
          type: "routed",
          source: edge.from,
          target: edge.to!,
          ...(path ? { sourceHandle: handleId(path) } : {}),
          animated: false,
          selected,
          style: edgeStyle(edge, selected),
          data,
        };
      });

    return { nodes: flowNodes, edges: flowEdges };
  }, [
    moduleGraph,
    layout,
    drawing,
    visible,
    sourcePathOf,
    isOpen,
    selectedKind,
    selectedId,
    selectedResource,
    viewData,
    toggleProperty,
    isEditableModule,
    editRowInputs,
    addRow,
    onMoveField,
    onRemoveField,
    onWriteRef,
    onExtractInline,
    onSelectResource,
    selectedEdges,
    mirrored,
    pickerOptions,
    selectRow,
  ]);


  /** A declaration the reader has asked to name, waiting on that name. */
  const [extracting, setExtracting] = useState<{
    host: { kind: string; name: string };
    pointer: string;
    kind: string;
  } | null>(null);

  /**
   * A drag that ended on the CANVAS rather than on a box.
   *
   * The gesture was already half-there: dragging out of a socket and letting go
   * in space did nothing at all, silently. It is the same request the `+` beside
   * a socket makes, so it opens the same menu — at the point the wire was let
   * go, which is where the reader is looking. What they choose is placed by the
   * LAYOUT rather than at the drop point, because the layout is solved again on
   * every edit, so a dropped position would survive exactly until the write that
   * created it.
   */
  const onConnectEnd = useCallback(
    (
      event: MouseEvent | TouchEvent,
      state: {
        toNode?: unknown;
        fromNode?: { id: string } | null;
        fromHandle?: { id?: string | null } | null;
      },
    ) => {
      if (state.toNode || !moduleGraph || !onWriteRef) return;
      const from = state.fromNode ? moduleGraph.nodeById(state.fromNode.id) : undefined;
      const site = from ? siteOfHandle(from, state.fromHandle?.id) : null;
      if (!site) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      setWiring({ site, at: { x: point.clientX, y: point.clientY } });
    },
    [moduleGraph, onWriteRef],
  );

  /** A drag is legal when the slot's own declared constraint accepts the target
   *  — the same `x-telo-ref` the checker validates the written reference
   *  against, so the canvas never allows a wire `telo check` would reject. */
  const isValidConnection = useCallback(
    (connection: { source?: string | null; sourceHandle?: string | null; target?: string | null }) => {
      if (!moduleGraph || !refResolver) return false;
      const from = connection.source ? moduleGraph.nodeById(connection.source) : undefined;
      const to = connection.target ? moduleGraph.nodeById(connection.target) : undefined;
      if (!from || !to) return false;
      const site = siteOfHandle(from, connection.sourceHandle);
      return !!site && !!spellingFor(site, to, refResolver);
    },
    [moduleGraph, refResolver],
  );

  /** Write the reference the drag described: point the site it started from at
   *  the resource it ended on, by the name a reference to it is WRITTEN with —
   *  alias-qualified when it crosses an import boundary, and in whichever
   *  spelling of that site accepts the target's kind. */
  const onConnect = useCallback(
    (connection: { source?: string | null; sourceHandle?: string | null; target?: string | null }) => {
      if (!moduleGraph || !onWriteRef || !refResolver) return;
      const from = connection.source ? moduleGraph.nodeById(connection.source) : undefined;
      const to = connection.target ? moduleGraph.nodeById(connection.target) : undefined;
      if (!from || !to) return;
      const site = siteOfHandle(from, connection.sourceHandle);
      const spelling = site ? spellingFor(site, to, refResolver) : undefined;
      if (!spelling) return;
      onWriteRef([
        {
          source: { kind: from.kind, name: from.name },
          concretePath: spelling.concretePath,
          target: referenceName(to),
        },
      ]);
    },
    [moduleGraph, onWriteRef, refResolver],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setSelectedEdges((current) => applyEdgeSelection(current, changes));
  }, []);

  /**
   * Delete the selected edges — which means clearing the reference each one
   * came from, since an edge is not a thing of its own: it is a slot holding a
   * name. An array item is spliced (its position is meaningful), a single slot
   * is cleared, and both go through the same write the drag does.
   */
  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      if (!moduleGraph || !onWriteRef) return;
      const writes: RefWrite[] = [];
      for (const flowEdge of deleted) {
        const edge = moduleGraph.edges.find((e) => e.id === flowEdge.id);
        if (!edge) continue;
        const from = moduleGraph.nodeById(edge.from);
        // A data read is not a slot — there is nothing to clear, and the CEL it
        // came from is edited where it was written.
        if (!from || edge.class === "data") continue;
        if (from.module && !isEditableModule(from.module)) continue;
        writes.push({
          source: { kind: from.kind, name: from.name },
          concretePath: edge.path,
          target: null,
        });
      }
      if (writes.length > 0) onWriteRef(writes);
      // The ids are about to stop existing — the write rebuilds the graph — so
      // the set is cleared rather than left holding names of nothing.
      setSelectedEdges(new Set());
    },
    [moduleGraph, onWriteRef, isEditableModule],
  );

  /**
   * Hold the canvas still across a re-layout.
   *
   * The flow is NOT remounted per expansion — it used to be keyed by the
   * collapsed set, so every toggle tore it down, restored a different viewport
   * and re-fitted, which is most of what "the screen moves" was. What remains is
   * that ELK legitimately re-places boxes when one changes height, so the
   * viewport moves by exactly what the anchor box moved and the rearrangement
   * happens around a fixed point.
   */
  const flow = useRef<ReactFlowInstance | null>(null);
  const previousLayout = useRef<ModuleGraphLayout | null>(null);
  useEffect(() => {
    const previous = previousLayout.current;
    previousLayout.current = layout;
    if (!layout || !flow.current) return;
    // The first layout arrives AFTER mount, because the solve is async — so the
    // canvas was empty when xyflow would have fitted it. Fit once, here, unless
    // the reader already has a saved viewport for this module.
    if (!previous) {
      if (!viewportFor(VIEWPORT_KEY)) flow.current.fitView({ padding: 0.15 });
      return;
    }
    const shift = anchorShift(previous, layout, anchor.current ?? defaultAnchor(previous, layout));
    anchor.current = null;
    if (!shift) return;
    const viewport = flow.current.getViewport();
    flow.current.setViewport({
      ...viewport,
      x: viewport.x - shift.dx * viewport.zoom,
      y: viewport.y - shift.dy * viewport.zoom,
    });
  }, [layout]);

  if (!moduleGraph || !layout) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-900">
        <span className="text-sm text-zinc-400 dark:text-zinc-600">Analyzing module…</span>
      </div>
    );
  }

  const kindOnly = kindPlaneIsSoleContent(moduleGraph, offCanvas?.ids ?? new Set());

  return (
    <div className="flex h-full min-h-0 flex-1">
      {!kindOnly && (
        <div className="relative h-full min-w-0 flex-1 bg-zinc-50 dark:bg-zinc-900">
          {layoutError && (
            <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
              <div className="pointer-events-auto max-w-lg rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 shadow-sm dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                This picture is out of date — the layout could not be solved:{" "}
                {layoutError}
              </div>
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={moduleGraphNodeTypes}
            edgeTypes={moduleGraphEdgeTypes}
            nodesDraggable={false}
            nodesConnectable={!!onWriteRef}
            // An edge is selectable so it can be deleted: it stands for a
            // reference, and clearing that reference is the only edit an edge
            // itself affords.
            edgesFocusable={!!onWriteRef}
            elementsSelectable={!!onWriteRef}
            deleteKeyCode={onWriteRef ? ["Delete", "Backspace"] : null}
            onEdgesChange={onEdgesChange}
            onEdgesDelete={onEdgesDelete}
            isValidConnection={isValidConnection}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onInit={(instance) => {
              flow.current = instance;
            }}
            defaultViewport={viewportFor(VIEWPORT_KEY) ?? undefined}
            fitView={!viewportFor(VIEWPORT_KEY)}
            onMoveEnd={(_e, vp) => onViewportChange(VIEWPORT_KEY, vp)}
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(e, node) => {
              if ((e.target as HTMLElement).closest("[data-no-open]")) return;
              (node.data as { onOpen?: () => void }).onOpen?.();
            }}
            onPaneClick={onBackgroundClick}
            defaultEdgeOptions={{ type: "routed" }}
          >
            <Background />
          </ReactFlow>
        </div>
      )}
      {wiring && wireOptions && (
        <WireMenu
          at={wiring.at}
          candidates={wireOptions.candidates}
          createKinds={wireOptions.createKinds}
          onPick={(reference) => fillWire({ reference })}
          onCreate={(createKind) => fillWire({ createKind })}
          onCancel={() => setWiring(null)}
        />
      )}
      {extracting && (
        <ExtractInlineDialog
          open
          onOpenChange={(next) => {
            if (!next) setExtracting(null);
          }}
          kind={extracting.kind}
          suggestion={suggestedResourceName(
            extracting.kind,
            viewData.kinds.get(extracting.kind)?.capability,
            resolvedResources.map((r) => r.name),
          )}
          taken={resolvedResources.map((r) => r.name)}
          onExtract={(name) => {
            onExtractInline?.(extracting.host, extracting.pointer, name);
            setExtracting(null);
          }}
        />
      )}
      <ModuleDrawer
        groups={drawerGroups({ graph: moduleGraph, offCanvas: offCanvas!, sole: kindOnly })}
        heldBy={drawerHeldBy}
        open={view.kindsOpen ?? false}
        sole={kindOnly}
        onToggle={() => patch({ kindsOpen: !view.kindsOpen })}
        selectedKind={selectedKind}
        onSelectKind={(kind) => patch({ kind })}
        selectedResource={selectedResource}
        onSelectResource={onSelectResource}
      />
    </div>
  );
}

/**
 * Which handle an edge leaves from — and, when that handle is not rendered,
 * none, so the edge docks on the box itself.
 *
 * Collapsing a box hides its rows, and a row's handle goes with them. An edge
 * naming a handle that does not exist is DROPPED by xyflow, which is why
 * collapsing used to delete the connection rather than summarise it: the whole
 * point of collapsing is to show less detail about a relation, not to deny the
 * relation exists.
 */
function sourceHandlePath(
  graph: ModuleGraph | null,
  edge: GraphEdge,
  isOpen: IsOpen,
): string | undefined {
  // A data read is not a slot, so it has no handle of its own.
  if (!graph || edge.class === "data") return undefined;
  const node = graph.nodeById(edge.from);
  if (edge.row) {
    const row = node?.rows.find((r) => r.id === edge.row);
    // A row that renders no socket has none to leave from — a declaration row,
    // and a slot already occupied by one. See `RowLine`.
    if (row && (row.kind === "inline" || row.dispatch?.inline)) return undefined;
    // A row inside a collapsed branch is not drawn, so its handle is not there
    // to leave from; the edge docks on the box. A body NESTS, so the branch is
    // shut when the property is or when any row above this one is.
    if (!row || !isOpen(edge.from, propertyOf(row.array))) return undefined;
    if (!isRowDrawn(node!.rows, row.id, (rowId) => isOpen(edge.from, rowId))) return undefined;
    return row.path;
  }
  // A port whose occupancy is drawn as rows renders no socket either.
  const port = node?.ports.find(
    (p) => p.slots.some((slot) => slot.path === edge.path) || p.addPath === edge.path,
  );
  // A picked slot draws a select and no socket, so nothing docks on it.
  if (!port || port.rowOwned || port.class === "shape" || isPickerPort(port)) return undefined;
  if (!isOpen(edge.from, propertyOf(port.slot))) return undefined;
  return edge.path;
}

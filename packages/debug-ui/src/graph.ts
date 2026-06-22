import { type DebugEvent, type DebugFrame, eventSuffix, isLogFrame } from "./wire.js";

/**
 * Pure, framework-agnostic derivation of a resource graph from a debug event
 * stream — the model behind the Graph view. No React, no layout: it folds the
 * frame buffer into nodes (one per resource) and edges (dependency wiring), and
 * tracks each node's lifecycle status and most-recent invocation. The component
 * layer adds positions (dagre) and rendering.
 *
 * Two event families drive it:
 *  - Lifecycle events `<Kind>.<Name>.{Created,Initialized,Teardown}` — a node
 *    appears (its payload carries the resolved `{kind,name}` and `dependencies`),
 *    then flips to `initialized` / `torndown`.
 *  - Dispatch (trace) events — every capability call emits a structured payload
 *    `{ spanId, parentSpanId, capability, phase, outcome, ref:{kind,name}, … }`.
 *    The consumer reads the *payload*, never the dotted name: `ref` locates the
 *    node, `outcome` records the result. Terminal events carry an `outcome`;
 *    `phase:"start"` events carry none and are skipped here.
 *
 * When the producer has tracing on, dispatch events also carry `spanId` /
 * `parentSpanId`; {@link deriveInvocations} folds those into the call tree behind
 * the invocation list + scoped trace graph.
 */

export type NodeStatus = "created" | "initialized" | "torndown";

export type InvokeOutcome = "ok" | "failed" | "rejected" | "cancelled";

/** The most recent invocation observed for a node. */
export interface InvokeRecord {
  outcome: InvokeOutcome;
  /** The terminal event's suffix (`Invoked`, `InvokeFailed`, …) — for display only. */
  suffix: string;
  timestamp: string;
  /** The dispatched inputs (present on every invocation event the kernel emits). */
  inputs?: unknown;
  /** The returned outputs — only on an `ok` outcome. */
  outputs?: unknown;
  /** The full raw event payload (error / cancellation detail for non-`ok`). */
  payload: unknown;
}

export interface GraphNode {
  /** Stable id — the resource's full hierarchical id (`<owner.id>/<kind>.<name>`),
   *  unique across instances of the same templated kind. Falls back to the bare
   *  name on a legacy stream that carries no `id`. */
  id: string;
  kind: string;
  name: string;
  module?: string;
  /** The owning resource's id, when this resource was spawned by another (a
   *  templated kind's child). Drives the collapsible parent/child grouping. */
  ownerId?: string;
  /** The resource's resolved config "after templating" (from the `Created`
   *  payload) — concrete values for compile-time CEL, `{kind,name}` for refs,
   *  `${{ … }}` for deferred runtime expressions, secrets scrubbed. */
  properties?: unknown;
  status: NodeStatus;
  /** Total invocations seen across the stream. */
  invokeCount: number;
  lastInvoke?: InvokeRecord;
  /** Buffer index of the last frame that touched this node — drives the pulse:
   *  the renderer flashes a node whose activity index advanced since last paint. */
  lastActivitySeq: number;
}

export interface GraphEdge {
  id: string;
  /** Source resource name (the dependant). */
  source: string;
  /** Target resource name (the dependency). */
  target: string;
  /** An ownership edge (owner → spawned child), not a dependency. Added when a
   *  templated resource is expanded so its revealed children stay attached to it;
   *  the renderer draws it distinctly (dashed/muted). */
  ownership?: boolean;
}

export interface GraphState {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface WireResourceRef {
  kind: string;
  name: string;
  module?: string;
  /** Full hierarchical id; absent on a legacy stream. */
  id?: string;
  alias?: string;
}

interface WireOwner {
  kind: string;
  name: string;
  id: string;
}

/** The id a node is keyed by: the producer's hierarchical `id`, or the bare name
 *  on a legacy stream. Globally unique when `id` is present. */
function nodeKey(ref: { id?: string; name: string }): string {
  return ref.id ?? ref.name;
}

function asResource(payload: unknown): WireResourceRef | undefined {
  const res = (payload as { resource?: unknown } | undefined)?.resource;
  if (res && typeof res === "object") {
    const { kind, name } = res as Record<string, unknown>;
    if (typeof kind === "string" && typeof name === "string") {
      return { kind, name, ...res } as WireResourceRef;
    }
  }
  return undefined;
}

/** The owning resource a lifecycle/dispatch payload carries under `owner`, when
 *  the resource was spawned by another (a templated kind's child). */
function readOwner(payload: unknown): WireOwner | undefined {
  const owner = (payload as { owner?: unknown } | undefined)?.owner;
  if (owner && typeof owner === "object") {
    const { kind, name, id } = owner as Record<string, unknown>;
    if (typeof kind === "string" && typeof name === "string" && typeof id === "string") {
      return { kind, name, id };
    }
  }
  return undefined;
}

/** The resolved ref a dispatch event's payload carries under `ref` — `id` keys
 *  the node (a templated child's calls land on the right instance). */
function readRef(
  payload: Record<string, unknown> | undefined,
): { kind: string; name: string; id?: string } | undefined {
  const ref = payload?.ref;
  if (ref && typeof ref === "object") {
    const { kind, name, id } = ref as Record<string, unknown>;
    if (typeof kind === "string" && typeof name === "string") {
      return { kind, name, id: typeof id === "string" ? id : undefined };
    }
  }
  return undefined;
}

/** Narrow a payload `outcome` to a known {@link InvokeOutcome}. Absent on
 *  `phase:"start"` events, so they are naturally skipped by callers. */
function asOutcome(value: unknown): InvokeOutcome | undefined {
  return value === "ok" || value === "failed" || value === "rejected" || value === "cancelled"
    ? value
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asCapability(value: unknown): SpanCapability | undefined {
  return value === "invoke" || value === "run" || value === "provide" || value === "request"
    ? value
    : undefined;
}

/**
 * Fold a frame buffer into the resource graph. Logs are ignored; events are
 * applied in arrival order so the returned status / `lastInvoke` reflect the
 * latest state. Edges are deduped by `source→target` and retained even when the
 * target node hasn't been seen (an imported dependency may live in another scope);
 * the renderer drops dangling edges.
 */
export function deriveGraph(frames: readonly DebugFrame[]): GraphState {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  frames.forEach((frame, seq) => {
    if (isLogFrame(frame)) return;
    const event = frame as DebugEvent;
    const suffix = eventSuffix(event.event);

    if (suffix === "Created") {
      const res = asResource(event.payload);
      if (!res) return;
      const key = nodeKey(res);
      const existing = nodes.get(key);
      if (existing) {
        existing.lastActivitySeq = seq;
      } else {
        nodes.set(key, {
          id: key,
          kind: res.kind,
          name: res.name,
          module: res.module,
          ownerId: readOwner(event.payload)?.id,
          properties: (event.payload as { properties?: unknown }).properties,
          status: "created",
          invokeCount: 0,
          lastActivitySeq: seq,
        });
      }
      const deps = (event.payload as { dependencies?: WireResourceRef[] }).dependencies ?? [];
      for (const dep of deps) {
        const depKey = dep?.name ? nodeKey(dep) : undefined;
        if (!depKey || depKey === key) continue;
        const id = `${key}->${depKey}`;
        if (!edges.has(id)) edges.set(id, { id, source: key, target: depKey });
      }
      return;
    }

    if (suffix === "Initialized" || suffix === "Teardown") {
      const res = asResource(event.payload);
      const node = res ? nodes.get(nodeKey(res)) : undefined;
      if (node) {
        node.status = suffix === "Teardown" ? "torndown" : "initialized";
        node.lastActivitySeq = seq;
      }
      return;
    }

    // Dispatch (trace) events: the payload's `ref.id` resolves the target node
    // directly (nodes are id-keyed). `phase:"start"` events carry no `outcome`
    // and are skipped — only terminal events record a result.
    const p = (event.payload ?? undefined) as Record<string, unknown> | undefined;
    const ref = readRef(p);
    const outcome = asOutcome(p?.outcome);
    const node = ref ? nodes.get(nodeKey(ref)) : undefined;
    if (!node || !outcome) return;
    node.invokeCount += 1;
    node.lastActivitySeq = seq;
    node.lastInvoke = {
      outcome,
      suffix: eventSuffix(event.event),
      timestamp: event.timestamp,
      inputs: p && "inputs" in p ? p.inputs : undefined,
      outputs: p && "outputs" in p ? p.outputs : undefined,
      payload: event.payload,
    };
  });

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// ── Owner grouping (collapsible parents) ────────────────────────────────────

/** A topology node augmented with its grouping state — how many direct children
 *  it owns and whether they are currently revealed. */
export interface GroupedGraphNode extends GraphNode {
  /** Number of resources directly owned by this node (spawned children). */
  childCount: number;
  /** Whether this node's children are currently shown (only meaningful when
   *  `childCount > 0`). */
  expanded: boolean;
}

export interface GroupedGraphState {
  nodes: GroupedGraphNode[];
  edges: GraphEdge[];
}

/** Count direct children per owner id — how many resources each node spawned. */
function countChildren(nodes: readonly GraphNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (n.ownerId) counts.set(n.ownerId, (counts.get(n.ownerId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Collapse a topology by owner: a resource spawned by another (a templated kind's
 * child) is hidden unless every ancestor in its owner chain is in `expanded`. A
 * collapsed parent absorbs its hidden descendants' edges — each edge endpoint is
 * remapped to its nearest visible ancestor — so the parent stays wired to the
 * rest of the graph as one node. Pure: drives the Graph view's collapse toggles
 * and is independently testable. With an empty `expanded` set, every owner is
 * collapsed (the default), so the top-level topology stays readable.
 */
export function collapseTopology(
  graph: GraphState,
  expanded: ReadonlySet<string>,
): GroupedGraphState {
  const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n] as [string, GraphNode]));
  const childCount = countChildren(graph.nodes);

  // A node is visible when no present ancestor in its owner chain is collapsed.
  const visible = (node: GraphNode): boolean => {
    let cur: GraphNode | undefined = node;
    while (cur?.ownerId) {
      const parent = byId.get(cur.ownerId);
      if (!parent) return true; // owner not in this stream — don't hide under an unknown
      if (!expanded.has(parent.id)) return false;
      cur = parent;
    }
    return true;
  };

  // The nearest visible ancestor an edge endpoint folds into.
  const resolveVisible = (id: string): string => {
    const start = byId.get(id);
    if (!start) return id;
    let node: GraphNode = start;
    while (!visible(node)) {
      const parent = node.ownerId ? byId.get(node.ownerId) : undefined;
      if (!parent) return node.id;
      node = parent;
    }
    return node.id;
  };

  const nodes = graph.nodes
    .filter(visible)
    .map((n) => ({ ...n, childCount: childCount.get(n.id) ?? 0, expanded: expanded.has(n.id) }));

  const edges = new Map<string, GraphEdge>();
  for (const e of graph.edges) {
    const source = resolveVisible(e.source);
    const target = resolveVisible(e.target);
    if (source === target) continue;
    const id = `${source}->${target}`;
    if (!edges.has(id)) edges.set(id, { id, source, target });
  }

  // Attach each revealed child to its owner: when a parent is expanded both it
  // and its children are visible, but no dependency edge ties them together, so
  // they would float as a detached cluster. An ownership edge keeps them grouped
  // (and pulls the children next to the parent in the layout).
  const visibleIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    if (n.ownerId && visibleIds.has(n.ownerId)) {
      const id = `owner:${n.ownerId}->${n.id}`;
      edges.set(id, { id, source: n.ownerId, target: n.id, ownership: true });
    }
  }

  return { nodes, edges: [...edges.values()] };
}

/**
 * The drill-down view of one templated resource: the parent node plus the direct
 * children it spawned. Children are wired by the dependency edges that run *among*
 * them (e.g. an Http.Api → its SQL handlers); anything pointing outside the
 * subtree is dropped (that wiring is visible at the level above). The parent
 * connects by an ownership edge only to children that aren't already reached by a
 * sibling's dependency edge — so a handler reached through the Http.Api isn't also
 * tied directly to the parent, leaving a clean tree instead of a redundant fan.
 * Each child that itself owns children reports its `childCount` for a further
 * drill-in. Pure and depth-independent: drilling into a child calls this again.
 */
export function subtreeGraph(topology: GraphState, ownerId: string): GroupedGraphState {
  const childCount = countChildren(topology.nodes);

  const parent = topology.nodes.find((n) => n.id === ownerId);
  const children = topology.nodes.filter((n) => n.ownerId === ownerId);

  const nodes: GroupedGraphNode[] = [];
  if (parent) nodes.push({ ...parent, childCount: childCount.get(parent.id) ?? 0, expanded: true });
  for (const c of children) {
    nodes.push({ ...c, childCount: childCount.get(c.id) ?? 0, expanded: false });
  }

  const present = new Set(nodes.map((n) => n.id));
  const edges = new Map<string, GraphEdge>();

  // Dependency edges among the shown nodes; track which are reached by one so the
  // parent doesn't also tie to a child already connected through a sibling.
  const reachedByDep = new Set<string>();
  for (const e of topology.edges) {
    if (e.source !== e.target && present.has(e.source) && present.has(e.target) && !edges.has(e.id)) {
      edges.set(e.id, e);
      reachedByDep.add(e.target);
    }
  }

  // Ownership edge parent → child, only for children not already wired in by a
  // sibling's dependency edge.
  for (const c of children) {
    if (reachedByDep.has(c.id)) continue;
    const id = `owner:${ownerId}->${c.id}`;
    edges.set(id, { id, source: ownerId, target: c.id, ownership: true });
  }

  return { nodes, edges: [...edges.values()] };
}

// ── Invocation traces ──────────────────────────────────────────────────────

/** Which capability the span represents. `"request"` is an inbound-boundary span. */
export type SpanCapability = "invoke" | "run" | "provide" | "request";

/** One invocation — a single dispatched call, identified by its `spanId`. */
export interface Invocation {
  id: number;
  parentId?: number;
  /** Trace this span belongs to — present while tracing; groups the call tree. */
  traceId?: string;
  kind: string;
  name: string;
  /** The dispatched resource's full hierarchical id; absent on a legacy stream.
   *  Keys the scoped trace graph so a templated child collapses per instance. */
  resourceId?: string;
  capability?: SpanCapability;
  outcome: InvokeOutcome;
  /** The terminal event's suffix (`Invoked`, `InvokeFailed`, …) — for display only. */
  suffix: string;
  /** Human label (e.g. a route `"POST /feedback"`), for `request` spans. */
  label?: string;
  /** Structured span attributes (e.g. `{ method, path }`). */
  attributes?: Record<string, unknown>;
  /** On a trace root: the redacted CEL root scope (variables / secrets / resources
   *  / ports) the trace could reference. */
  context?: Record<string, unknown>;
  timestamp: string;
  inputs?: unknown;
  outputs?: unknown;
  /** Full raw event payload (error / cancellation detail for non-`ok`). */
  payload: unknown;
}

export interface TraceState {
  /** Every invocation, keyed by id. */
  byId: Map<number, Invocation>;
  /** Child invocation ids per parent id. */
  childrenOf: Map<number, number[]>;
  /** Root invocations (no parent), in arrival order. */
  roots: Invocation[];
}

/**
 * Fold the dispatch events that carry a `spanId` into a call tree. Each
 * invocation appears once — keyed by `spanId`, the first terminal event wins, so
 * the `InvokeRejected.Undeclared` echo (same id, emitted after `InvokeRejected`)
 * is deduped. `phase:"start"` events carry no `outcome` and are skipped. Empty
 * when the producer isn't tracing (no `spanId`).
 */
export function deriveInvocations(frames: readonly DebugFrame[]): TraceState {
  const byId = new Map<number, Invocation>();
  const childrenOf = new Map<number, number[]>();
  const roots: Invocation[] = [];

  for (const frame of frames) {
    if (isLogFrame(frame)) continue;
    const event = frame as DebugEvent;
    const p = (event.payload ?? undefined) as Record<string, unknown> | undefined;
    const id = num(p?.spanId);
    if (id === undefined || byId.has(id)) continue;
    const outcome = asOutcome(p?.outcome);
    if (!outcome) continue;
    const ref = readRef(p);
    if (!ref) continue;

    const parentId = num(p?.parentSpanId);
    const invocation: Invocation = {
      id,
      parentId,
      traceId: typeof p?.traceId === "string" ? p.traceId : undefined,
      kind: ref.kind,
      name: ref.name,
      resourceId: ref.id,
      capability: asCapability(p?.capability),
      outcome,
      suffix: eventSuffix(event.event),
      label: typeof p?.label === "string" ? p.label : undefined,
      attributes:
        p?.attributes && typeof p.attributes === "object"
          ? (p.attributes as Record<string, unknown>)
          : undefined,
      context:
        p?.context && typeof p.context === "object"
          ? (p.context as Record<string, unknown>)
          : undefined,
      timestamp: event.timestamp,
      inputs: p && "inputs" in p ? p.inputs : undefined,
      outputs: p && "outputs" in p ? p.outputs : undefined,
      payload: event.payload,
    };
    byId.set(id, invocation);
    if (parentId === undefined) {
      roots.push(invocation);
    } else {
      const list = childrenOf.get(parentId);
      if (list) list.push(id);
      else childrenOf.set(parentId, [id]);
    }
  }

  return { byId, childrenOf, roots };
}

/** One resource in a scoped trace graph — collapses repeated calls to the same
 *  resource into a single node carrying all its invocations within that trace. */
export interface TraceNode {
  /** Resource key `kind.name`. */
  id: string;
  kind: string;
  name: string;
  /** Human label from the span (e.g. a route `"POST /feedback"`), if any. */
  label?: string;
  isRoot: boolean;
  invocations: Invocation[];
}

export interface TraceEdge {
  id: string;
  source: string;
  target: string;
}

export interface TraceSubgraph {
  nodes: TraceNode[];
  edges: TraceEdge[];
}

/**
 * The call graph of a single trace: the resources that participated in `rootId`'s
 * subtree, wired by the actual parent→child call edges. A resource invoked more
 * than once in the trace is one node holding all its calls; edges are deduped by
 * `source→target`.
 */
export function traceSubgraph(trace: TraceState, rootId: number): TraceSubgraph {
  const root = trace.byId.get(rootId);
  if (!root) return { nodes: [], edges: [] };

  const resourceKey = (inv: Invocation) => inv.resourceId ?? `${inv.kind}.${inv.name}`;
  const nodes = new Map<string, TraceNode>();
  const edges = new Map<string, TraceEdge>();

  const visit = (id: number): void => {
    const inv = trace.byId.get(id);
    if (!inv) return;
    const key = resourceKey(inv);
    const node = nodes.get(key);
    if (node) node.invocations.push(inv);
    else
      nodes.set(key, {
        id: key,
        kind: inv.kind,
        name: inv.name,
        label: inv.label,
        isRoot: id === rootId,
        invocations: [inv],
      });

    for (const childId of trace.childrenOf.get(id) ?? []) {
      const child = trace.byId.get(childId);
      if (!child) continue;
      const target = resourceKey(child);
      if (key !== target) {
        const edgeId = `${key}->${target}`;
        if (!edges.has(edgeId)) edges.set(edgeId, { id: edgeId, source: key, target });
      }
      visit(childId);
    }
  };
  visit(rootId);

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

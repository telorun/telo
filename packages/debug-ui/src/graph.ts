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
  /** Stable id — the resource name (dot-free, unique within its module scope). */
  id: string;
  kind: string;
  name: string;
  module?: string;
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
}

export interface GraphState {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface WireResourceRef {
  kind: string;
  name: string;
  module?: string;
  alias?: string;
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

/** The resolved `{kind,name}` a dispatch event's payload carries under `ref`. */
function readRef(payload: Record<string, unknown> | undefined): { kind: string; name: string } | undefined {
  const ref = payload?.ref;
  if (ref && typeof ref === "object") {
    const { kind, name } = ref as Record<string, unknown>;
    if (typeof kind === "string" && typeof name === "string") return { kind, name };
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
      const existing = nodes.get(res.name);
      if (existing) {
        existing.lastActivitySeq = seq;
      } else {
        nodes.set(res.name, {
          id: res.name,
          kind: res.kind,
          name: res.name,
          module: res.module,
          status: "created",
          invokeCount: 0,
          lastActivitySeq: seq,
        });
      }
      const deps = (event.payload as { dependencies?: WireResourceRef[] }).dependencies ?? [];
      for (const dep of deps) {
        if (!dep?.name || dep.name === res.name) continue;
        const id = `${res.name}->${dep.name}`;
        if (!edges.has(id)) edges.set(id, { id, source: res.name, target: dep.name });
      }
      return;
    }

    if (suffix === "Initialized" || suffix === "Teardown") {
      const res = asResource(event.payload);
      const node = res ? nodes.get(res.name) : undefined;
      if (node) {
        node.status = suffix === "Teardown" ? "torndown" : "initialized";
        node.lastActivitySeq = seq;
      }
      return;
    }

    // Dispatch (trace) events: the payload's `ref.name` resolves the target node
    // directly (nodes are name-keyed). `phase:"start"` events carry no `outcome`
    // and are skipped — only terminal events record a result.
    const p = (event.payload ?? undefined) as Record<string, unknown> | undefined;
    const ref = readRef(p);
    const outcome = asOutcome(p?.outcome);
    const node = ref ? nodes.get(ref.name) : undefined;
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

  const resourceKey = (inv: Invocation) => `${inv.kind}.${inv.name}`;
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

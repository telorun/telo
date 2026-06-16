import { type DebugEvent, type DebugFrame, eventSuffix, isLogFrame } from "./wire.js";

/**
 * Pure, framework-agnostic derivation of a resource graph from a debug event
 * stream — the model behind the Graph view. No React, no layout: it folds the
 * frame buffer into nodes (one per resource) and edges (dependency wiring), and
 * tracks each node's lifecycle status and most-recent invocation. The component
 * layer adds positions (dagre) and rendering.
 *
 * Three event families drive it, all named `<Kind>.<Name>.<Suffix>`:
 *  - `.Created`     → a node appears (status `created`); its payload carries the
 *                     resolved `{kind,name}` and the `dependencies` (the edges).
 *  - `.Initialized` → the node flips to `initialized`.
 *  - `.Teardown`    → the node flips to `torndown`.
 *  - invocation suffixes (`Invoked`, `InvokeFailed`, `InvokeRejected[.Undeclared]`,
 *    `InvokeCancelled`, `RunCancelled`) → record the call's outcome, inputs and
 *    outputs on the matching node.
 *
 * When the producer has tracing on, invocation events also carry
 * `metadata.invocationId` / `metadata.parentInvocationId`; {@link deriveInvocations}
 * folds those into the call tree behind the invocation list + scoped trace graph.
 */

export type NodeStatus = "created" | "initialized" | "torndown";

export type InvokeOutcome = "ok" | "failed" | "rejected" | "cancelled";

/** The most recent invocation observed for a node. */
export interface InvokeRecord {
  outcome: InvokeOutcome;
  /** The suffix part after `<Kind>.<Name>.` (e.g. `Invoked`, `InvokeFailed`). */
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

function classify(suffix: string): InvokeOutcome | undefined {
  if (suffix === "Invoked") return "ok";
  if (suffix.startsWith("InvokeFailed")) return "failed";
  if (suffix.startsWith("InvokeRejected")) return "rejected";
  if (suffix === "InvokeCancelled" || suffix === "RunCancelled") return "cancelled";
  return undefined;
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

    // Invocation events share `parseInvocationEvent` with the trace fold — nodes
    // are name-keyed, so the parsed resource name resolves the target directly.
    const parsed = parseInvocationEvent(event.event);
    const node = parsed ? nodes.get(parsed.name) : undefined;
    if (!parsed || !node) return;
    const outcome = classify(parsed.suffix);
    if (!outcome) return;
    node.invokeCount += 1;
    node.lastActivitySeq = seq;
    const p = (event.payload ?? undefined) as Record<string, unknown> | undefined;
    node.lastInvoke = {
      outcome,
      suffix: parsed.suffix,
      timestamp: event.timestamp,
      inputs: p && "inputs" in p ? p.inputs : undefined,
      outputs: p && "outputs" in p ? p.outputs : undefined,
      payload: event.payload,
    };
  });

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// ── Invocation traces ──────────────────────────────────────────────────────

/** One invocation — a single dispatched call, identified by its `invocationId`. */
export interface Invocation {
  id: number;
  parentId?: number;
  kind: string;
  name: string;
  outcome: InvokeOutcome;
  /** The event suffix (`Invoked`, `InvokeFailed`, …). */
  suffix: string;
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

/** Known invocation suffixes, longest first so `InvokeRejected.Undeclared` wins
 *  over `InvokeRejected`. */
const INVOKE_SUFFIXES = [
  "InvokeRejected.Undeclared",
  "InvokeCancelled",
  "InvokeRejected",
  "InvokeFailed",
  "Invoked",
  "RunCancelled",
] as const;

/** Split a dotted invocation event into `{ kind, name, suffix }` by stripping a
 *  known trailing suffix — self-contained, no node registry needed. */
function parseInvocationEvent(event: string): { kind: string; name: string; suffix: string } | undefined {
  for (const suffix of INVOKE_SUFFIXES) {
    if (event.endsWith(`.${suffix}`)) {
      const head = event.slice(0, event.length - suffix.length - 1);
      const dot = head.lastIndexOf(".");
      if (dot <= 0) return undefined;
      return { kind: head.slice(0, dot), name: head.slice(dot + 1), suffix };
    }
  }
  return undefined;
}

function metaId(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Fold the invocation events that carry `metadata.invocationId` into a call tree.
 * Each invocation appears once (the `.Undeclared` rejection echo is deduped by id,
 * keeping the primary event). Empty when the producer isn't tracing.
 */
export function deriveInvocations(frames: readonly DebugFrame[]): TraceState {
  const byId = new Map<number, Invocation>();
  const childrenOf = new Map<number, number[]>();
  const roots: Invocation[] = [];

  for (const frame of frames) {
    if (isLogFrame(frame)) continue;
    const event = frame as DebugEvent;
    const id = metaId((event.metadata as Record<string, unknown> | undefined)?.invocationId);
    if (id === undefined || byId.has(id)) continue;
    const parsed = parseInvocationEvent(event.event);
    if (!parsed) continue;
    const outcome = classify(parsed.suffix);
    if (!outcome) continue;

    const parentId = metaId((event.metadata as Record<string, unknown>).parentInvocationId);
    const p = (event.payload ?? undefined) as Record<string, unknown> | undefined;
    const invocation: Invocation = {
      id,
      parentId,
      kind: parsed.kind,
      name: parsed.name,
      outcome,
      suffix: parsed.suffix,
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
    else nodes.set(key, { id: key, kind: inv.kind, name: inv.name, isRoot: id === rootId, invocations: [inv] });

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

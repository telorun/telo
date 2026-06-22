import Dagre from "@dagrejs/dagre";
import {
  Background,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  collapseTopology,
  deriveGraph,
  deriveInvocations,
  type GraphEdge,
  type GraphNode,
  type GraphState,
  type GroupedGraphNode,
  type Invocation,
  subtreeGraph,
  type TraceNode,
  traceSubgraph,
} from "../graph.js";
import type { DebugEvent } from "../wire.js";
import { PayloadInspector } from "./PayloadInspector.js";

export interface EventGraphProps {
  /** The event stream, in arrival order. Logs are already filtered out. */
  events: readonly DebugEvent[];
  /** Resolve a blob pointer to a fetchable URL (passed through to the inspector). */
  resolveUrl: (rel: string) => string;
}

const NODE_WIDTH = 190;
const NODE_HEIGHT = 52;

const badgeClass = (outcome: Invocation["outcome"]) =>
  `tdbg-badge tdbg-suffix-${outcome === "ok" ? "invoked" : outcome}`;

// ── Custom nodes ────────────────────────────────────────────────────────────

interface TopologyNodeData extends Record<string, unknown> {
  node: GroupedGraphNode;
  selected: boolean;
}

/** Live-topology node: status dot, name + kind, invocation badge; pulses on each
 *  new invocation, tinted by outcome. A node that owns spawned children (a
 *  templated kind) shows an "n internal" badge — clicking it opens the drill-down
 *  pane with that resource and the children it spawned. */
function TopologyNode({ data }: NodeProps<Node<TopologyNodeData>>) {
  const { node, selected } = data;
  const [pulse, setPulse] = useState<"" | "ok" | "bad">("");
  const prevSeq = useRef(node.lastActivitySeq);

  useEffect(() => {
    if (node.lastActivitySeq === prevSeq.current) return;
    prevSeq.current = node.lastActivitySeq;
    if (!node.lastInvoke) return;
    setPulse(node.lastInvoke.outcome === "ok" ? "ok" : "bad");
    const t = setTimeout(() => setPulse(""), 650);
    return () => clearTimeout(t);
  }, [node.lastActivitySeq, node.lastInvoke]);

  const cls = [
    "tdbg-node",
    `tdbg-node-${node.status}`,
    node.childCount > 0 ? "tdbg-node-owner" : "",
    selected ? "tdbg-node-sel" : "",
    pulse ? `tdbg-node-pulse-${pulse}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} className="tdbg-node-handle" />
      <div className="tdbg-node-head">
        <span className={`tdbg-node-dot tdbg-node-dot-${node.status}`} />
        <span className="tdbg-node-name">{node.name}</span>
        {node.invokeCount > 0 && (
          <span
            className={`tdbg-node-count${
              node.lastInvoke && node.lastInvoke.outcome !== "ok" ? " tdbg-node-count-bad" : ""
            }`}
          >
            {node.invokeCount}×
          </span>
        )}
      </div>
      <div className="tdbg-node-kind">{node.kind}</div>
      {node.childCount > 0 && (
        <span className="tdbg-node-internal">{node.childCount} internal ›</span>
      )}
      <Handle type="source" position={Position.Right} className="tdbg-node-handle" />
    </div>
  );
}

interface TraceNodeData extends Record<string, unknown> {
  node: TraceNode;
  selected: boolean;
}

/** Scoped-trace node: a resource that took part in the selected invocation. The
 *  root is marked; the outcome of its last call in the trace tints the box. */
function TraceFlowNode({ data }: NodeProps<Node<TraceNodeData>>) {
  const { node, selected } = data;
  const last = node.invocations[node.invocations.length - 1];
  const cls = [
    "tdbg-node",
    "tdbg-node-initialized",
    node.isRoot ? "tdbg-node-root" : "",
    selected ? "tdbg-node-sel" : "",
    last.outcome !== "ok" ? "tdbg-node-bad" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} className="tdbg-node-handle" />
      <div className="tdbg-node-head">
        {node.isRoot && <span className="tdbg-node-roottag">root</span>}
        <span className="tdbg-node-name">{node.label ?? node.name}</span>
        <span className={badgeClass(last.outcome)}>
          {node.invocations.length > 1 ? `${node.invocations.length}×` : last.suffix}
        </span>
      </div>
      <div className="tdbg-node-kind">{node.label ? `${node.kind} · ${node.name}` : node.kind}</div>
      <Handle type="source" position={Position.Right} className="tdbg-node-handle" />
    </div>
  );
}

const nodeTypes = { topology: TopologyNode, trace: TraceFlowNode };

/** dagre LR layout → id-keyed top-left positions. Works for either graph shape
 *  (both expose `nodes[].id` + `edges[].{source,target}`). */
function layoutPositions(graph: {
  nodes: { id: string }[];
  edges: { source: string; target: string }[];
}): Map<string, { x: number; y: number }> {
  const present = new Set(graph.nodes.map((n) => n.id));
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 70 });
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of graph.edges) {
    if (present.has(e.source) && present.has(e.target)) g.setEdge(e.source, e.target);
  }
  Dagre.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of graph.nodes) {
    const p = g.node(n.id);
    pos.set(n.id, { x: (p?.x ?? 0) - NODE_WIDTH / 2, y: (p?.y ?? 0) - NODE_HEIGHT / 2 });
  }
  return pos;
}

/** Map graph edges to ReactFlow edges, dropping any whose endpoints aren't shown.
 *  Ownership edges (owner → child) render dashed + muted so they read as
 *  containment, not data flow. */
function buildFlowEdges(edges: readonly GraphEdge[], present: ReadonlySet<string>): Edge[] {
  return edges
    .filter((e) => present.has(e.source) && present.has(e.target))
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.ownership
        ? {
            className: "tdbg-edge-owner",
            style: { stroke: "var(--tdbg-muted)", strokeDasharray: "5 4", opacity: 0.65 },
          }
        : {}),
    }));
}

/** The main canvas shows the topology fully collapsed — templated resources are
 *  one node each; their children are reached through the drill-down pane. */
const NO_EXPANSION: ReadonlySet<string> = new Set();

// ── The view ────────────────────────────────────────────────────────────────

/**
 * The Graph view. The left rail lists every root invocation; selecting one scopes
 * the canvas to just the resources that took part in that call (wired by the real
 * parent→child call edges). With nothing selected, the canvas shows the live
 * resource topology — gray on `Created`, brighter on `Initialized`, pulsing per
 * invocation. Selecting a node opens its inputs → outputs.
 */
export function EventGraph({ events, resolveUrl }: EventGraphProps) {
  const [traceId, setTraceId] = useState<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Drill-down stack of owner ids: clicking a templated resource pushes it and
  // opens the nested pane; the breadcrumb pops back. Empty = pane closed.
  const [drilldown, setDrilldown] = useState<string[]>([]);

  // Default on: standalone services / providers with no dependency wiring are
  // usually noise in the topology view.
  const [hideUnconnected, setHideUnconnected] = useState(true);

  const topology = useMemo(() => deriveGraph(events), [events]);
  const trace = useMemo(() => deriveInvocations(events), [events]);

  // A selected trace that's no longer present (buffer trimmed) falls back to live.
  const activeTraceId = traceId !== null && trace.byId.has(traceId) ? traceId : null;
  const scoped = useMemo(
    () => (activeTraceId !== null ? traceSubgraph(trace, activeTraceId) : null),
    [trace, activeTraceId],
  );

  // The main canvas is the fully-collapsed topology: a templated resource is one
  // node (absorbing its children's edges); the children are reached by clicking it.
  const collapsed = useMemo(() => collapseTopology(topology, NO_EXPANSION), [topology]);

  // Topology with isolated nodes (no incoming/outgoing edge) dropped when the
  // toggle is on. Only meaningful for the live topology — trace subgraphs are all
  // connected by call edges.
  const displayTopology = useMemo(() => {
    if (!hideUnconnected) return collapsed;
    const connected = new Set<string>();
    for (const e of collapsed.edges) {
      connected.add(e.source);
      connected.add(e.target);
    }
    return { nodes: collapsed.nodes.filter((n) => connected.has(n.id)), edges: collapsed.edges };
  }, [collapsed, hideUnconnected]);
  const hiddenCount = collapsed.nodes.length - displayTopology.nodes.length;

  const graph = scoped ?? displayTopology;
  const topoKey = useMemo(
    () =>
      `${activeTraceId ?? "live"}#${graph.nodes.map((n) => n.id).join(",")}|${graph.edges
        .map((e) => e.id)
        .join(",")}`,
    [graph, activeTraceId],
  );
  const positions = useMemo(() => layoutPositions(graph), [topoKey]);
  const present = useMemo(() => new Set(graph.nodes.map((n) => n.id)), [graph]);

  const flowNodes: Node[] = useMemo(() => {
    if (scoped) {
      return scoped.nodes.map((n) => ({
        id: n.id,
        type: "trace",
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { node: n, selected: n.id === selectedNodeId } satisfies TraceNodeData,
      }));
    }
    return displayTopology.nodes.map((n) => ({
      id: n.id,
      type: "topology",
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      data: { node: n, selected: n.id === selectedNodeId } satisfies TopologyNodeData,
    }));
  }, [scoped, displayTopology, positions, selectedNodeId]);

  const flowEdges = useMemo(
    () => buildFlowEdges(graph.edges as readonly GraphEdge[], present),
    [graph, present],
  );

  const selectTrace = (id: number | null) => {
    setTraceId(id);
    setSelectedNodeId(null);
    setDrilldown([]);
  };

  // Clicking a templated resource (one that owns children) opens the drill-down
  // pane; any other node opens its inputs/outputs detail.
  const onTopologyNodeClick = (id: string) => {
    const node = displayTopology.nodes.find((n) => n.id === id);
    if (node && node.childCount > 0) {
      setDrilldown([id]);
      setSelectedNodeId(null);
    } else {
      setSelectedNodeId(id);
    }
  };

  return (
    <div className="tdbg-graph">
      <TraceList
        roots={trace.roots}
        childCount={(id) => countSubtree(trace, id)}
        activeId={activeTraceId}
        onSelect={selectTrace}
      />
      <div className="tdbg-graph-canvas">
        {graph.nodes.length === 0 ? (
          <div className="tdbg-empty">
            {activeTraceId !== null
              ? "No resources in this trace."
              : hideUnconnected && collapsed.nodes.length > 0
                ? `All ${collapsed.nodes.length} resource(s) are unconnected — turn off "Hide unconnected" to show them.`
                : "No resources yet — waiting for the stream…"}
          </div>
        ) : (
          <ReactFlow
            // Remount when the scope changes (an invocation is selected/cleared)
            // so `fitView` re-runs against the new node set.
            key={activeTraceId ?? "live"}
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            fitView
            minZoom={0.2}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_e, node) =>
              scoped ? setSelectedNodeId(node.id) : onTopologyNodeClick(node.id)
            }
            onPaneClick={() => setSelectedNodeId(null)}
          >
            <Background />
            <Controls showInteractive={false} />
            {!scoped && (
              <Panel position="top-right">
                <label className="tdbg-graph-toggle">
                  <input
                    type="checkbox"
                    checked={hideUnconnected}
                    onChange={(e) => setHideUnconnected(e.target.checked)}
                  />
                  Hide unconnected
                  {hideUnconnected && hiddenCount > 0 && (
                    <span className="tdbg-muted"> ({hiddenCount})</span>
                  )}
                </label>
              </Panel>
            )}
          </ReactFlow>
        )}
      </div>
      {selectedNodeId &&
        (scoped ? (
          <TraceNodeDetail
            node={scoped.nodes.find((n) => n.id === selectedNodeId)}
            resolveUrl={resolveUrl}
            onClose={() => setSelectedNodeId(null)}
          />
        ) : (
          <NodeDetail
            node={topology.nodes.find((n) => n.id === selectedNodeId)}
            resolveUrl={resolveUrl}
            onClose={() => setSelectedNodeId(null)}
          />
        ))}
      {!scoped && drilldown.length > 0 && (
        <>
          <div className="tdbg-nested-backdrop" onClick={() => setDrilldown([])} />
          {drilldown.map((ownerId, i) => (
            <NestedGraphPane
              key={`${ownerId}@${i}`}
              topology={topology}
              ownerId={ownerId}
              depth={i}
              isTop={i === drilldown.length - 1}
              onDrill={(childId) => setDrilldown((d) => [...d.slice(0, i + 1), childId])}
              onReveal={() => setDrilldown((d) => d.slice(0, i + 1))}
              onClose={() => setDrilldown((d) => d.slice(0, i))}
              resolveUrl={resolveUrl}
            />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * One panel in the drill-down stack — a templated resource and the children it
 * spawned (`subtreeGraph`), wired by dashed ownership edges plus the dependency
 * edges among them. Each drill-in pushes a *new* panel (cascaded to the right);
 * clicking a child that owns its own children opens the next panel, recursive to
 * any depth. Only the top panel is interactive; clicking a panel beneath pops the
 * stack back to it, and clicking a leaf (or the parent) opens its detail.
 */
function NestedGraphPane({
  topology,
  ownerId,
  depth,
  isTop,
  onDrill,
  onReveal,
  onClose,
  resolveUrl,
}: {
  topology: GraphState;
  ownerId: string;
  depth: number;
  isTop: boolean;
  onDrill: (childId: string) => void;
  onReveal: () => void;
  onClose: () => void;
  resolveUrl: (rel: string) => string;
}) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const nodeById = useMemo(() => new Map(topology.nodes.map((n) => [n.id, n])), [topology]);
  const sub = useMemo(() => subtreeGraph(topology, ownerId), [topology, ownerId]);
  const positions = useMemo(() => layoutPositions(sub), [sub]);
  const present = useMemo(() => new Set(sub.nodes.map((n) => n.id)), [sub]);

  const flowNodes: Node[] = useMemo(
    () =>
      sub.nodes.map((n) => ({
        id: n.id,
        type: "topology",
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { node: n, selected: n.id === selectedNodeId } satisfies TopologyNodeData,
      })),
    [sub, positions, selectedNodeId],
  );
  const flowEdges = useMemo(() => buildFlowEdges(sub.edges, present), [sub, present]);

  const onNodeClick = (id: string) => {
    const node = sub.nodes.find((n) => n.id === id);
    // A child that owns its own children opens the next panel; the parent itself
    // or a leaf opens its detail in this panel.
    if (id !== ownerId && node && node.childCount > 0) onDrill(id);
    else setSelectedNodeId(id);
  };

  const owner = nodeById.get(ownerId);
  const detailNode = selectedNodeId ? nodeById.get(selectedNodeId) : undefined;

  return (
    <aside
      className={`tdbg-nested-pane${isTop ? "" : " tdbg-nested-pane-under"}`}
      // `--tdbg-depth` drives the cascade offset (`left`) in CSS, so a media query
      // can tighten it on a narrow screen; z-index stacks the panels.
      style={{ zIndex: 20 + depth, ["--tdbg-depth"]: depth } as CSSProperties}
      // A panel beneath the top acts as a single "go back here" surface.
      onClick={isTop ? undefined : onReveal}
    >
      <div className="tdbg-nested-head">
        <span className="tdbg-nested-title">
          <span className="tdbg-node-name">{owner?.name ?? ownerId}</span>
          {owner && <span className="tdbg-muted">{owner.kind}</span>}
        </span>
        <button
          className="tdbg-btn tdbg-icon-btn"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close"
        >
          ✕
        </button>
      </div>
      <div className="tdbg-nested-body" style={{ pointerEvents: isTop ? "auto" : "none" }}>
        <div className="tdbg-nested-canvas">
          {sub.nodes.length === 0 ? (
            <div className="tdbg-empty">This resource spawned no children.</div>
          ) : (
            <ReactFlow
              key={ownerId}
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              fitView
              minZoom={0.2}
              proOptions={{ hideAttribution: true }}
              onNodeClick={(_e, node) => onNodeClick(node.id)}
              onPaneClick={() => setSelectedNodeId(null)}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
        {detailNode && (
          <NodeDetail
            node={detailNode}
            resolveUrl={resolveUrl}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>
    </aside>
  );
}

function countSubtree(trace: ReturnType<typeof deriveInvocations>, rootId: number): number {
  let n = 0;
  const visit = (id: number) => {
    n += 1;
    for (const c of trace.childrenOf.get(id) ?? []) visit(c);
  };
  visit(rootId);
  return n;
}

function TraceList({
  roots,
  childCount,
  activeId,
  onSelect,
}: {
  roots: Invocation[];
  childCount: (id: number) => number;
  activeId: number | null;
  onSelect: (id: number | null) => void;
}) {
  return (
    <aside className="tdbg-trace-list">
      <div className="tdbg-trace-list-head">Invocations</div>
      <button
        className={`tdbg-trace-row${activeId === null ? " tdbg-trace-row-on" : ""}`}
        onClick={() => onSelect(null)}
      >
        <span className="tdbg-node-name">Live topology</span>
      </button>
      {roots.length === 0 ? (
        <div className="tdbg-trace-empty">
          No traced invocations yet. Run with <code>--inspect</code> to capture traces.
        </div>
      ) : (
        [...roots].reverse().map((r) => {
          const calls = childCount(r.id);
          return (
            <button
              key={r.id}
              className={`tdbg-trace-row${activeId === r.id ? " tdbg-trace-row-on" : ""}`}
              onClick={() => onSelect(r.id)}
            >
              <span className="tdbg-time">{r.timestamp.slice(11, 23)}</span>
              <span className="tdbg-node-name">{r.name}</span>
              <span className={badgeClass(r.outcome)}>{r.outcome === "ok" ? "ok" : r.outcome}</span>
              {calls > 1 && <span className="tdbg-trace-calls">{calls}</span>}
            </button>
          );
        })
      )}
    </aside>
  );
}

function NodeDetail({
  node,
  resolveUrl,
  onClose,
}: {
  node: GraphNode | undefined;
  resolveUrl: (rel: string) => string;
  onClose: () => void;
}) {
  if (!node) return null;
  const i = node.lastInvoke;
  const props = node.properties;
  const hasProps =
    !!props && typeof props === "object" && Object.keys(props as object).length > 0;
  return (
    <aside className="tdbg-graph-detail">
      <DetailHead name={node.name} onClose={onClose} />
      <div className="tdbg-graph-detail-meta">
        <span className="tdbg-muted">{node.kind}</span>
        <span className={`tdbg-badge tdbg-suffix-${node.status}`}>{node.status}</span>
        <span className="tdbg-muted">{node.invokeCount} invocation(s)</span>
      </div>
      {hasProps && (
        <div className="tdbg-graph-detail-body">
          <div className="tdbg-graph-detail-label">Properties</div>
          <PayloadInspector value={props} resolveUrl={resolveUrl} />
        </div>
      )}
      {i ? (
        <div className="tdbg-graph-detail-body">
          <div className="tdbg-graph-detail-sub">
            Last call
            <span className={badgeClass(i.outcome)}>{i.suffix}</span>
            <span className="tdbg-muted">{i.timestamp.slice(11, 23)}</span>
          </div>
          <InOut inv={i} resolveUrl={resolveUrl} />
        </div>
      ) : (
        <div className="tdbg-empty">Not invoked yet.</div>
      )}
    </aside>
  );
}

function TraceNodeDetail({
  node,
  resolveUrl,
  onClose,
}: {
  node: TraceNode | undefined;
  resolveUrl: (rel: string) => string;
  onClose: () => void;
}) {
  if (!node) return null;
  return (
    <aside className="tdbg-graph-detail">
      <DetailHead name={node.name} onClose={onClose} />
      <div className="tdbg-graph-detail-meta">
        <span className="tdbg-muted">{node.kind}</span>
        {node.isRoot && <span className="tdbg-badge tdbg-suffix-created">root</span>}
        <span className="tdbg-muted">{node.invocations.length} call(s) in trace</span>
      </div>
      <div className="tdbg-graph-detail-body">
        {node.invocations.map((inv) => (
          <div key={inv.id} className="tdbg-graph-detail-body">
            <div className="tdbg-graph-detail-sub">
              <span className={badgeClass(inv.outcome)}>{inv.suffix}</span>
              <span className="tdbg-muted">#{inv.id}</span>
              <span className="tdbg-muted">{inv.timestamp.slice(11, 23)}</span>
            </div>
            <InOut inv={inv} resolveUrl={resolveUrl} />
            {inv.context !== undefined && (
              <>
                <div className="tdbg-graph-detail-label">Available context</div>
                <PayloadInspector value={inv.context} resolveUrl={resolveUrl} />
              </>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

function DetailHead({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <div className="tdbg-graph-detail-head">
      <span className="tdbg-node-name">{name}</span>
      <button className="tdbg-btn tdbg-icon-btn" onClick={onClose} title="Close">
        ✕
      </button>
    </div>
  );
}

function InOut({
  inv,
  resolveUrl,
}: {
  inv: Pick<Invocation, "outcome" | "inputs" | "outputs" | "payload">;
  resolveUrl: (rel: string) => string;
}) {
  return (
    <>
      <div className="tdbg-graph-detail-label">Inputs</div>
      <PayloadInspector value={inv.inputs} resolveUrl={resolveUrl} />
      <div className="tdbg-graph-detail-label">{inv.outcome === "ok" ? "Outputs" : "Error"}</div>
      <PayloadInspector value={inv.outcome === "ok" ? inv.outputs : inv.payload} resolveUrl={resolveUrl} />
    </>
  );
}

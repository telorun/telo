import {
  Background,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Button } from "../../../ui/button";
import { capLabel } from "../ApplicationTopologyCanvas";
import { focusChain, isSharedChild, type ContainmentTree, type NodeId } from "../containment";
import { boxKey, expandableKeys, layoutNested } from "../nested-layout";
import type { TopologyViewProps } from "../topology-view";
import {
  subflowNodeTypes,
  type SubflowContainerData,
  type SubflowLaneData,
  type SubflowNodeData,
} from "./subflow-nodes";

/** This view's own state. Opaque to the host, which persists it under the
 *  view's id and never reads it — so no other view has to know that nesting is
 *  expressed as an expansion set. */
interface SubflowState {
  /** Box keys drawn open. A key is per OCCURRENCE, so expanding a shared
   *  resource under one container leaves it collapsed under the others. */
  expanded: string[];
}

function readState(state: unknown): SubflowState | null {
  if (!state || typeof state !== "object") return null;
  const expanded = (state as SubflowState).expanded;
  return Array.isArray(expanded) ? { expanded: expanded.filter((k) => typeof k === "string") } : null;
}

/** Ancestors of the focus path, so switching into this view from another lands
 *  on the same thing rather than at the root. */
function chainKeys(tree: ContainmentTree, focusPath: NodeId[]): string[] {
  return focusChain(tree, focusPath).map((_, i) => boxKey(tree, focusPath.slice(0, i)));
}

/**
 * The containment tree drawn as nested frames — a container and its contents on
 * screen together, so the shape of a module is visible at a glance rather than
 * one level at a time.
 *
 * Deliberately not an editing surface beyond adding into a slot: nodes keep
 * their port rail for reading, but wiring lives in the drill view, which has the
 * room. Two views differing in what they are *for* is the point of them being
 * separate components.
 */
export function SubflowCanvas({
  tree,
  model,
  focusPath,
  onFocusPath,
  selectedResource,
  state,
  onStateChange,
  viewportFor,
  onViewportChange,
  onSelectResource,
  onWriteRef,
  onBackgroundClick,
}: TopologyViewProps) {
  // Keyed on the stored value's identity, not on a re-read of it: `readState`
  // returns a fresh object every call, so memoizing on that would rebuild the
  // whole nested layout — a dagre pass per lane — on every render.
  const expanded = useMemo(() => new Set(readState(state)?.expanded ?? []), [state]);

  // First paint (and a switch in from another view) opens the focus chain. Once
  // the user has expanded or collapsed anything, their set is authoritative and
  // nothing re-seeds it underneath them.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!tree) return;
    const stored = readState(state);
    const chain = chainKeys(tree, focusPath);
    const signature = chain.join("|");
    if (stored && seededFor.current === signature) return;
    seededFor.current = signature;
    const next = new Set(stored?.expanded ?? []);
    for (const key of chain) next.add(key);
    if (!stored || next.size !== stored.expanded.length) {
      onStateChange({ expanded: [...next] } satisfies SubflowState);
    }
  }, [tree, focusPath, state, onStateChange]);

  const layout = useMemo(
    () => (tree && model ? layoutNested(tree, model, { focusPath, expanded, hoist: isSharedChild }) : null),
    [tree, model, expanded, focusPath],
  );

  const toggle = useCallback(
    (key: string) => {
      const next = new Set(expanded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onStateChange({ expanded: [...next] } satisfies SubflowState);
    },
    [expanded, onStateChange],
  );

  const onCreateInSlot = useCallback(
    (owner: { kind: string; name: string }, concretePath: string, kind: string) => {
      onWriteRef?.([{ source: owner, concretePath, target: null, createKind: kind }]);
    },
    [onWriteRef],
  );

  const { nodes, edges } = useMemo<{ nodes: Node[]; edges: Edge[] }>(() => {
    if (!layout) return { nodes: [], edges: [] };

    // Only the boxes an edge actually touches get a socket, so a leaf is drawn
    // clean rather than carrying two unused dots.
    const sources = new Set(layout.edges.map((e) => e.sourceKey));
    const targets = new Set(layout.edges.map((e) => e.targetKey));
    const laneNodes: Node[] = layout.lanes.map((lane) => ({
      id: lane.key,
      type: "lane",
      position: { x: lane.x, y: lane.y },
      ...(lane.parentKey ? { parentId: lane.parentKey } : {}),
      style: { width: lane.width, height: lane.height },
      selectable: false,
      draggable: false,
      data: {
        order: lane.order,
        lane,
        onCreate: onWriteRef
          ? (path: string, kind: string) => onCreateInSlot(lane.owner, path, kind)
          : undefined,
      } satisfies SubflowLaneData,
    }));

    const boxNodes: Node[] = layout.boxes.map((b) => {
      const selected = selectedResource?.name === b.id && selectedResource?.kind === b.node.kind;
      // Re-rooting is what depth costs past the budget: the box opens, it just
      // opens as a new view root rather than as another frame.
      const open = b.reroots ? () => onFocusPath(b.path) : () => toggle(b.key);
      return b.expanded
        ? ({
            id: b.key,
            type: "container",
            position: { x: b.x, y: b.y },
            parentId: b.laneKey,
            style: { width: b.width, height: b.height },
            selectable: false,
            data: {
              order: b.order,
              box: b,
              selected,
              hasSource: sources.has(b.key),
              hasTarget: targets.has(b.key),
              onToggle: () => toggle(b.key),
              onOpen: () => onSelectResource(b.node.kind, b.id),
              onFocus: () => onFocusPath(b.path),
            } satisfies SubflowContainerData,
          } satisfies Node)
        : ({
            id: b.key,
            type: "resource",
            position: { x: b.x, y: b.y },
            parentId: b.laneKey,
            style: { width: b.width, height: b.height },
            data: {
              order: b.order,
              box: b,
              selected,
              hasSource: sources.has(b.key),
              hasTarget: targets.has(b.key),
              onOpen: () => onSelectResource(b.node.kind, b.id),
              onOpenInterior: b.openable ? open : undefined,
            } satisfies SubflowNodeData,
          } satisfies Node);
    });

    return {
      // Lanes and boxes interleave by containment depth, and xyflow needs a
      // parent before its child. Emission order already satisfies that within
      // each family, so a stable sort on depth-in-the-parent chain is enough.
      nodes: [...laneNodes, ...boxNodes].sort(
        (a, b) => (a.data as { order: number }).order - (b.data as { order: number }).order,
      ),
      edges: layout.edges.map((e) => ({
        id: e.id,
        source: e.sourceKey,
        target: e.targetKey,
        style: { stroke: "#d4d4d8" },
        selectable: false,
        deletable: false,
      })),
    };
  }, [layout, selectedResource, toggle, onSelectResource, onFocusPath, onWriteRef, onCreateInSlot]);

  const viewportKey = `subflow:${focusPath.join("/")}`;
  const onViewport = useCallback(
    (vp: Parameters<typeof onViewportChange>[1]) => onViewportChange(viewportKey, vp),
    [onViewportChange, viewportKey],
  );

  if (!tree || !layout) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-900">
        <span className="text-sm text-zinc-400 dark:text-zinc-600">Analyzing module…</span>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-1">
      <ReactFlow
        key={viewportKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={subflowNodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        defaultViewport={viewportFor(viewportKey) ?? undefined}
        fitView={!viewportFor(viewportKey)}
        onMoveEnd={(_e, vp) => onViewport(vp)}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(e, node) => {
          if ((e.target as HTMLElement).closest("[data-no-open]")) return;
          const data = node.data as { onOpen?: () => void };
          data.onOpen?.();
        }}
        onPaneClick={onBackgroundClick}
      >
        <Background />
        <Controls showInteractive={false} />
        {/* Expansion is this view's own state, so its controls are its own. The
            breadcrumb that used to carry them is the host's now — it says where
            the focus is, which is true of every view. */}
        <Panel position="top-left">
          <div className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white/90 px-1 py-0.5 shadow-sm backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/90">
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[11px]"
              onClick={() =>
                onStateChange({
                  expanded: [...expandableKeys(tree, { focusPath, hoist: isSharedChild })],
                } satisfies SubflowState)
              }
            >
              Expand all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[11px]"
              onClick={() => onStateChange({ expanded: [] } satisfies SubflowState)}
            >
              Collapse
            </Button>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}

import Dagre from "@dagrejs/dagre";
import type { AppCanvasModel, GraphNode } from "./application-canvas-model";
import {
  childrenAt,
  focusChain,
  focusedId,
  pathKey,
  type ContainmentChild,
  type ContainmentTree,
  type NodeId,
} from "./containment";
import type { NodePort } from "./node-ports";

/**
 * The nested view's own metrics.
 *
 * A node here is an IDENTITY CHIP — name, kind, whether it opens — and nothing
 * else, so its size is a constant rather than a function of what it contains.
 * That is the difference between the two views made concrete: the level canvas
 * grows a node to fit its port rail and its steps because that is where wiring
 * happens, while a nested frame is about position, and a rail inside a frame
 * inside a frame is detail nobody reads at that zoom. The layout owns the
 * numbers because the renderer and the geometry have to agree on them.
 */
export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 44;

/** Header strip of an expanded container — its name and collapse control. */
export const CONTAINER_HEADER = 26;
/** Breathing room between a container's frame and its contents. */
export const CONTAINER_PAD = 14;
/** Label strip above one lane. */
export const LANE_LABEL = 16;
/** Vertical gap between lanes. */
export const LANE_GAP = 12;
/** Content height of a lane holding nothing yet. An addable slot has a lane
 *  before it has an entry — otherwise the view could show a module's `targets`
 *  and offer no way to put the first one there. */
export const EMPTY_LANE_HEIGHT = 30;

/**
 * How many frames deep nesting goes before depth becomes navigation.
 *
 * Frames express containment by geometry, and geometry runs out: the hub's
 * deepest chain is eight resources, which as eight nested frames is eight
 * borders, eight header strips and ~230px of padding around the innermost box,
 * all inside one rectangle the size of the canvas. Past a few levels the picture
 * stops being about structure and starts being about margins. Beyond the budget
 * a container still opens — it re-roots the view instead of growing.
 */
export const MAX_NEST_DEPTH = 3;

export interface NestedLane {
  /** Emission order. xyflow resolves `parentId` by array position, so a parent
   *  must precede its children; lanes and boxes interleave, so the single
   *  counter across both is what a consumer sorts on. */
  order: number;
  /** xyflow node id. Per container, so the same slot name in two containers is
   *  two lanes. */
  key: string;
  label: string;
  /** Container this lane belongs to; absent for the view root's own lanes,
   *  which sit directly on the canvas. */
  parentKey?: string;
  /** Position relative to the parent container (or the canvas at the root). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The resource whose slot this is — the write target for the add control. */
  owner: { kind: string; name: string };
  /** Concrete path a new entry is appended at, when this lane is an
   *  array-of-refs slot. Its presence is what makes the lane addable. */
  addPath?: string;
  /** Kinds the add control offers — those that satisfy the slot's constraint. */
  createKinds?: string[];
}

export interface NestedBox {
  /** Emission order — see {@link NestedLane.order}. */
  order: number;
  /** Unique per OCCURRENCE, not per resource. */
  key: string;
  id: NodeId;
  node: GraphNode;
  /** Focus path of this occurrence — what a view hands to `onFocusPath`. */
  path: NodeId[];
  /** xyflow parent: the LANE holding it. */
  laneKey: string;
  /** The container the lane belongs to — what siblinghood is measured by.
   *  Empty at the view root. */
  containerKey: string;
  /** Position relative to its lane. */
  x: number;
  y: number;
  width: number;
  height: number;
  expanded: boolean;
  childCount: number;
  shared: boolean;
  cyclic: boolean;
  /** Labels of every parent slot that reaches this box; laid out in the lane of
   *  the first. */
  via: string[];
  /** Has an interior to open — children, or a slot to add the first one to. */
  openable: boolean;
  /** Opening it re-roots the view rather than expanding in place: it sits at
   *  the depth budget. */
  reroots: boolean;
  depth: number;
}

export interface NestedEdge {
  id: string;
  sourceKey: string;
  targetKey: string;
}

export interface NestedLayout {
  /** Pre-order: a container precedes its lanes, and a lane its members — the
   *  order xyflow needs for `parentId` to resolve. */
  boxes: NestedBox[];
  lanes: NestedLane[];
  edges: NestedEdge[];
  width: number;
  height: number;
}

export interface NestedOptions {
  /** Where the view is rooted. The root is NOT drawn as a frame — it is always
   *  the outermost container, so its frame would be the canvas border: a header,
   *  two pads and one nesting level on everything inside, saying nothing the
   *  breadcrumb does not. Its lanes sit directly on the canvas instead. */
  focusPath: readonly NodeId[];
  expanded: ReadonlySet<string>;
  /**
   * Children to divert out of the tree entirely.
   *
   * A view policy, not a property of the relation: the tree keeps the DAG, and a
   * view that draws real edges (the drill view) can afford to show a child under
   * each of its referrers, while one that expresses containment by geometry
   * cannot — a node several containers reference is not inside any of them, and
   * drawing it in each is what takes the hub from 19 boxes to 88.
   */
  hoist?: (child: ContainmentChild) => boolean;
  /** Frames deep before opening re-roots instead. Defaults to `MAX_NEST_DEPTH`. */
  maxDepth?: number;
}

export function boxKey(tree: ContainmentTree, path: readonly NodeId[]): string {
  return pathKey(focusChain(tree, path));
}

function addableSlots(node: GraphNode | undefined): NodePort[] {
  return (node?.ports ?? []).filter((p) => p.flavor === "edge" && p.addPath);
}

/**
 * Lays the containment tree out as nested frames, rooted at `focusPath`.
 *
 * A bottom-up recursion: an expanded container's interior is laid out FIRST, its
 * resulting extent becomes that container's size, and the level above then sees a
 * flat graph of correctly-sized boxes. dagre never learns that anything is
 * nested, so its lack of cluster support — the usual objection to drawing a graph
 * this way — never comes up.
 */
export function layoutNested(
  tree: ContainmentTree,
  model: AppCanvasModel,
  opts: NestedOptions,
): NestedLayout {
  const maxDepth = opts.maxDepth ?? MAX_NEST_DEPTH;
  const references = edgeIndex(model);
  const boxes: NestedBox[] = [];
  const lanes: NestedLane[] = [];
  let order = 0;

  /** Children this view will actually draw. What the hoist rule diverts is
   *  simply not drawn here — it stays reachable in the levels view, which draws
   *  it at every referrer. */
  const visibleChildren = (path: readonly NodeId[]): ContainmentChild[] =>
    childrenAt(tree, path).filter((c) => !opts.hoist?.(c));

  const buildBox = (
    parentPath: readonly NodeId[],
    child: ContainmentChild,
    depth: number,
    containerKey: string,
    laneKey: string,
  ): NestedBox => {
    const path = [...parentPath, child.id];
    const key = boxKey(tree, path);
    // Counted over what this view draws, not over the raw relation: a container
    // whose every child is hoisted has nothing to open, and offering the control
    // anyway would open an empty frame.
    const childCount = child.cyclic ? 0 : visibleChildren(path).length;
    const openable = !child.cyclic && (childCount > 0 || addableSlots(child.node).length > 0);
    const reroots = openable && depth >= maxDepth;
    const expanded = openable && !reroots && opts.expanded.has(key);

    const box: NestedBox = {
      order: order++,
      key,
      id: child.id,
      node: child.node,
      path,
      laneKey,
      containerKey,
      x: 0,
      y: 0,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      expanded,
      childCount,
      shared: child.shared,
      cyclic: child.cyclic,
      via: child.via,
      openable,
      reroots,
      depth,
    };
    boxes.push(box);

    if (expanded) {
      const inner = layoutInterior(path, depth + 1, key);
      box.width = Math.max(NODE_WIDTH, inner.width + 2 * CONTAINER_PAD);
      box.height = CONTAINER_HEADER + CONTAINER_PAD + inner.height + CONTAINER_PAD;
    }
    return box;
  };

  /** Lays out one container's lanes and returns the extent they occupy. Members
   *  are positioned relative to their lane, lanes relative to their container. */
  const layoutInterior = (
    path: readonly NodeId[],
    depth: number,
    containerKey: string,
  ): { width: number; height: number } => {
    const ownerId = focusedId(tree, path);
    const owner = tree.nodeById.get(ownerId);
    const groups = laneGroups(visibleChildren(path), addableSlots(owner));

    // A container offsets its interior past its own header; the root has none.
    const originX = containerKey ? CONTAINER_PAD : 0;
    const originY = containerKey ? CONTAINER_HEADER + CONTAINER_PAD : 0;

    // Lanes are emitted BEFORE the boxes they hold, and a box before its own
    // lanes — so emission order is already the parent-first order xyflow needs.
    // Geometry is filled in below, once the members have been sized.
    const laneOf = groups.map((group) => {
      const lane: NestedLane = {
        order: order++,
        key: `${containerKey}#${group.label}`,
        label: group.label,
        ...(containerKey ? { parentKey: containerKey } : {}),
        x: originX,
        y: originY,
        width: 0,
        height: 0,
        owner: { kind: owner?.kind ?? "", name: ownerId },
        ...(group.addPath ? { addPath: group.addPath, createKinds: group.createKinds } : {}),
      };
      lanes.push(lane);
      return lane;
    });

    let top = originY;
    let widest = 0;
    groups.forEach((group, i) => {
      const lane = laneOf[i];
      const members = group.members.map((c) => buildBox(path, c, depth, containerKey, lane.key));
      // An unlabelled group gets no strip: there is no slot to name, and a blank
      // strip would read as a lane whose label failed to render.
      const contentTop = group.label ? LANE_LABEL : 0;
      const size = layoutRow(members, references, contentTop);
      lane.y = top;
      lane.width = size.width;
      lane.height = contentTop + size.height;
      widest = Math.max(widest, size.width);
      top += lane.height + LANE_GAP;
    });

    return { width: widest, height: Math.max(top - LANE_GAP - originY, 0) };
  };

  const root = layoutInterior(opts.focusPath, 0, "");

  return {
    boxes,
    lanes,
    edges: siblingLinks(boxes, references),
    width: root.width,
    height: root.height,
  };
}

/**
 * Children grouped by the slot that holds them, in first-appearance order —
 * which is edge order, which is declaration order, so a container's lanes read
 * in the order the manifest lists its slots.
 *
 * Nesting CONSUMES the edge, and the edge was what said which slot holds a
 * child: "inside the Application" and "in the Application's targets list" are
 * different facts, and only the second says the resource runs on boot. A lane
 * puts that back by GROUPING, so the slot is named once per group and position
 * within it carries the slot's order.
 *
 * A lane is seeded for every array-of-refs slot, filled or not — the lane IS the
 * slot, so an empty `targets` still has somewhere to add the first entry. A
 * child reached from several slots lands in the lane of the first: one
 * occurrence is one box, and duplicating it per lane would give two boxes the
 * same key. The unlabelled group — a resource nothing references — sorts last;
 * it is the leftover, not a slot.
 */
function laneGroups(
  children: ContainmentChild[],
  addable: NodePort[],
): { label: string; members: ContainmentChild[]; addPath?: string; createKinds?: string[] }[] {
  const byLabel = new Map<string, ContainmentChild[]>();
  for (const p of addable) if (!byLabel.has(p.label)) byLabel.set(p.label, []);
  for (const m of children) {
    const label = m.via[0] ?? "";
    const list = byLabel.get(label) ?? [];
    list.push(m);
    byLabel.set(label, list);
  }
  const unlabelled = byLabel.get("");
  byLabel.delete("");

  const out = [...byLabel].map(([label, group]) => {
    const port = addable.find((p) => p.label === label);
    return { label, members: group, addPath: port?.addPath, createKinds: port?.createKinds };
  });
  if (unlabelled?.length) {
    out.push({ label: "", members: unlabelled, addPath: undefined, createKinds: undefined });
  }
  return out;
}

/** Lays one lane out with dagre, writing each member's position relative to the
 *  lane. Returns the lane's content extent. */
function layoutRow(
  members: NestedBox[],
  references: Map<NodeId, Set<NodeId>>,
  originY: number,
): { width: number; height: number } {
  if (members.length === 0) return { width: NODE_WIDTH, height: EMPTY_LANE_HEIGHT };

  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 56 });
  for (const m of members) g.setNode(m.key, { width: m.width, height: m.height });
  for (const m of members) {
    for (const to of references.get(m.id) ?? []) {
      for (const o of members) if (o.id === to && o !== m) g.setEdge(m.key, o.key);
    }
  }
  Dagre.layout(g);

  // dagre reports centres in its own frame; shift so the lane starts at its origin.
  let minX = Infinity;
  let minY = Infinity;
  for (const m of members) {
    const p = g.node(m.key);
    minX = Math.min(minX, (p?.x ?? 0) - m.width / 2);
    minY = Math.min(minY, (p?.y ?? 0) - m.height / 2);
  }

  let width = 0;
  let height = 0;
  for (const m of members) {
    const p = g.node(m.key);
    m.x = (p?.x ?? 0) - m.width / 2 - minX;
    m.y = (p?.y ?? 0) - m.height / 2 - minY + originY;
    width = Math.max(width, m.x + m.width);
    height = Math.max(height, m.y - originY + m.height);
  }
  return { width, height };
}

/** `from` → the ids it references, for both the per-lane dagre pass and the
 *  drawn links. */
function edgeIndex(model: AppCanvasModel): Map<NodeId, Set<NodeId>> {
  const map = new Map<NodeId, Set<NodeId>>();
  for (const e of model.edges) {
    if (e.from === e.to) continue;
    const set = map.get(e.from) ?? new Set<NodeId>();
    set.add(e.to);
    map.set(e.from, set);
  }
  return map;
}

/**
 * Links between boxes in the SAME container — across lanes as well as within
 * one, since lanes group by slot and a reference may cross them.
 *
 * A container's reference to something drawn inside it is already stated by the
 * nesting, so drawing it again would be a line from a frame into its own belly.
 * A reference that crosses containers is not drawn either — following it is the
 * drill view's job, which has real edges.
 */
function siblingLinks(boxes: NestedBox[], references: Map<NodeId, Set<NodeId>>): NestedEdge[] {
  const byContainer = new Map<string, NestedBox[]>();
  for (const b of boxes) {
    const list = byContainer.get(b.containerKey) ?? [];
    list.push(b);
    byContainer.set(b.containerKey, list);
  }
  const out: NestedEdge[] = [];
  for (const group of byContainer.values()) {
    for (const from of group) {
      for (const to of group) {
        if (from === to || !references.get(from.id)?.has(to.id)) continue;
        out.push({ id: `${from.key}->${to.key}`, sourceKey: from.key, targetKey: to.key });
      }
    }
  }
  return out;
}

/** Every box key a fully-open view would produce, capped at `maxDepth` — the
 *  seed for "expand all". Uses the same visibility policy as the layout, so it
 *  never opens a container this view draws nothing in. */
export function expandableKeys(
  tree: ContainmentTree,
  opts: Pick<NestedOptions, "focusPath" | "hoist"> & { maxDepth?: number },
): Set<string> {
  const maxDepth = opts.maxDepth ?? MAX_NEST_DEPTH;
  const out = new Set<string>();
  const visit = (path: readonly NodeId[], depth: number): void => {
    if (depth > maxDepth) return;
    const children = childrenAt(tree, path).filter((c) => !opts.hoist?.(c));
    const node = tree.nodeById.get(focusedId(tree, path));
    if (children.length > 0 || addableSlots(node).length > 0) out.add(boxKey(tree, path));
    for (const c of children) {
      if (c.cyclic) continue;
      visit([...path, c.id], depth + 1);
    }
  };
  visit(opts.focusPath, 0);
  return out;
}

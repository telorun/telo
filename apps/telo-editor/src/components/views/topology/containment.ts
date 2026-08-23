import type { AppCanvasModel, GraphNode } from "./application-canvas-model";

/**
 * The containment relation the nested topology views navigate — "what is inside
 * what", derived statically from the manifest.
 *
 * debug-ui nests on runtime ownership (the kernel stamps `owner.id` on every
 * `Created` event). The editor has no kernel, so the relation has to be derived,
 * and the obvious candidate — the `use` vocabulary's control-transfer projection
 * — does not answer it: `Http.Server.mounts[].mount` is `use: dependency`, and
 * correctly so (control reaches the route handlers, never the `Http.Api`). A
 * mounted API would stay at level 0, the opposite of what nesting is for.
 *
 * What makes a resource read as *inside* another is that the other is the only
 * thing that reaches it. So containment here is the reference graph rooted at
 * the module root, with two rules:
 *
 *  - **Every referenced node is a child of its referrer.** A node several others
 *    reference is a child of each — the DAG is expanded into a tree at view
 *    time, and each occurrence is flagged `shared` so it reads as one
 *    declaration seen from several places, not as copies.
 *  - **Whatever the root cannot REACH hangs off it.** A resource nothing references would be
 *    unreachable from any level and would simply vanish from the canvas.
 *
 * No kind is named here. `Telo.Mount` ending up under its server is not a rule —
 * it falls out, because a Mount is never a boot target and has one referrer.
 * `Telo.Provider` / `Telo.Type` never enter the relation at all: the model keeps
 * them in the ambient side strip, so they are not among `model.nodes` and a
 * connection twelve resources share cannot flatten the hierarchy.
 *
 * NOT YET COVERED: resources declared *inline* at a ref slot, and `with:`-scoped
 * ones. Those are the only truly-owned children (they exist nowhere but the
 * parent's YAML), but neither is a node in `AppCanvasModel` today — an inline
 * declaration has no name to key on, and a scoped one is not a top-level
 * resource — so surfacing them is its own change. `childrenOf` is the seam it
 * would extend.
 */
export type NodeId = string;

/**
 * One containment edge: the child, and the labels of the parent's slots that
 * reach it.
 *
 * The label is carried rather than derived later because nesting CONSUMES the
 * edge — a view that draws a child inside its parent no longer draws the line
 * that said which slot holds it, and "inside the Application" is a materially
 * different fact from "in the Application's targets list". A view can put the
 * label back; it cannot recover it.
 *
 * Plural because one parent may reach one child from several slots (two mounts
 * of the same API, a handler that is also a boot target).
 */
export interface ContainmentLink {
  id: NodeId;
  via: string[];
}

export interface ContainmentTree {
  rootId: NodeId;
  /** Children per node, in the order their edges appear. A DAG, not a tree. */
  childrenOf: ReadonlyMap<NodeId, readonly ContainmentLink[]>;
  /** Distinct referrers per node — more than one means shared. */
  referrers: ReadonlyMap<NodeId, number>;
  nodeById: ReadonlyMap<NodeId, GraphNode>;
}

/** One child as a view renders it: the node plus the three facts that decide
 *  how it is drawn — whether it can be opened, whether opening would loop, and
 *  whether editing it here edits it everywhere. */
export interface ContainmentChild {
  id: NodeId;
  node: GraphNode;
  /** Referenced by more than one node — the same declaration, shown in each. */
  shared: boolean;
  /** Already on the focus path: descending would loop, so a view links to it
   *  rather than opening it. */
  cyclic: boolean;
  /** Size of its interior. Zero means a leaf — nothing to open. */
  childCount: number;
  /** Labels of the parent slots that reach it — see {@link ContainmentLink}. */
  via: string[];
}

const EMPTY: readonly ContainmentLink[] = [];

/**
 * The hoist rule: a node several containers reference is inside none of them.
 *
 * Stated as a function rather than inline in the layout because it is a VIEW
 * POLICY over the relation, not a property of it — the levels view draws such a
 * node at every referrer, and only the nested view, whose geometry cannot afford
 * a box per referrer, declines to.
 */
export function isSharedChild(child: Pick<ContainmentChild, "shared">): boolean {
  return child.shared;
}

/**
 * Folds the module's canvas model into the containment DAG. Edges are the
 * model's own (port edges + step-internal invokes), so every reference a view
 * can draw is also a containment edge — the two never disagree about what is
 * connected.
 */
export function buildContainmentTree(model: AppCanvasModel): ContainmentTree {
  const nodeById = new Map(model.nodes.map((n) => [n.name, n] as const));
  const rootId = model.nodes.find((n) => n.isRoot)?.name ?? model.nodes[0]?.name ?? "";

  const childrenOf = new Map<NodeId, ContainmentLink[]>();
  const referrerSets = new Map<NodeId, Set<NodeId>>();

  for (const e of model.edges) {
    // A self-reference is not containment — nothing is inside itself.
    if (e.from === e.to) continue;
    if (!nodeById.has(e.from) || !nodeById.has(e.to)) continue;
    const kids = childrenOf.get(e.from) ?? [];
    const existing = kids.find((k) => k.id === e.to);
    if (existing) {
      if (e.label && !existing.via.includes(e.label)) existing.via.push(e.label);
    } else {
      kids.push({ id: e.to, via: e.label ? [e.label] : [] });
    }
    childrenOf.set(e.from, kids);
    const refs = referrerSets.get(e.to) ?? new Set<NodeId>();
    refs.add(e.from);
    referrerSets.set(e.to, refs);
  }

  // Attach whatever the root cannot REACH, which is not the same as whatever
  // nothing references. A reference cycle gives every member a referrer, so a
  // referrer count attached none of them and two `Run.Sequence`s that invoke
  // each other — or anything reached only from inside such a pair — dropped out
  // of the relation entirely: absent from every level, unroutable by
  // `findPathTo`, and excluded from the boot list's "not wired up" section too,
  // which asks the same question the same way. Unreachable and undeletable in
  // the topology tab. Reachability is what the doc above always claimed, and it
  // degrades to the referrer count on an acyclic graph.
  const reached = new Set<NodeId>([rootId]);
  const queue: NodeId[] = [rootId];
  while (queue.length) {
    for (const link of childrenOf.get(queue.shift()!) ?? []) {
      if (reached.has(link.id)) continue;
      reached.add(link.id);
      queue.push(link.id);
    }
  }

  const rootKids = childrenOf.get(rootId) ?? [];
  for (const n of model.nodes) {
    if (n.name === rootId || reached.has(n.name)) continue;
    // Entering the component at this node is what makes the rest of it
    // reachable, so the walk continues from here — otherwise a three-node cycle
    // would be attached three times, once per member.
    reached.add(n.name);
    const walk: NodeId[] = [n.name];
    while (walk.length) {
      for (const link of childrenOf.get(walk.shift()!) ?? []) {
        if (reached.has(link.id)) continue;
        reached.add(link.id);
        walk.push(link.id);
      }
    }
    if (!rootKids.some((k) => k.id === n.name)) rootKids.push({ id: n.name, via: [] });
  }
  childrenOf.set(rootId, rootKids);

  const referrers = new Map<NodeId, number>();
  for (const [id, set] of referrerSets) referrers.set(id, set.size);

  return { rootId, childrenOf, referrers, nodeById };
}

/** The node a focus path designates — its last entry, or the root when empty. */
export function focusedId(tree: ContainmentTree, path: readonly NodeId[]): NodeId {
  return path.length ? path[path.length - 1] : tree.rootId;
}

/** Full chain from the root through `path`, the breadcrumb's backing list. */
export function focusChain(tree: ContainmentTree, path: readonly NodeId[]): NodeId[] {
  return [tree.rootId, ...path];
}

export function childCountOf(tree: ContainmentTree, id: NodeId): number {
  return (tree.childrenOf.get(id) ?? EMPTY).length;
}

/** Children of the node `path` designates, each classified for rendering. */
export function childrenAt(
  tree: ContainmentTree,
  path: readonly NodeId[],
): ContainmentChild[] {
  const onPath = new Set(focusChain(tree, path));
  const out: ContainmentChild[] = [];
  for (const link of tree.childrenOf.get(focusedId(tree, path)) ?? EMPTY) {
    const node = tree.nodeById.get(link.id);
    if (!node) continue;
    out.push({
      id: link.id,
      node,
      via: link.via,
      shared: (tree.referrers.get(link.id) ?? 0) > 1,
      cyclic: onPath.has(link.id),
      childCount: childCountOf(tree, link.id),
    });
  }
  return out;
}

/**
 * Trims a focus path to what the current tree still supports, so a path held
 * across an edit (a renamed or deleted resource, a cleared ref) degrades to its
 * deepest valid prefix instead of rendering an empty level. A cycle is cut for
 * the same reason `childrenAt` marks one — a path may not revisit a node.
 */
export function resolveFocusPath(
  tree: ContainmentTree,
  path: readonly NodeId[],
): NodeId[] {
  const out: NodeId[] = [];
  const seen = new Set<NodeId>([tree.rootId]);
  let current = tree.rootId;
  for (const id of path) {
    if (seen.has(id)) break;
    if (!(tree.childrenOf.get(current) ?? EMPTY).some((k) => k.id === id)) break;
    if (!tree.nodeById.has(id)) break;
    out.push(id);
    seen.add(id);
    current = id;
  }
  return out;
}

/** Stable key for one occurrence of a node — its whole path, since a shared
 *  node appears at several and each occurrence is its own rendered thing. */
export function pathKey(path: readonly NodeId[]): string {
  return path.join("/");
}

/**
 * A route from the root to `id`, for a caller that names a RESOURCE rather than
 * a route — a list row, the rail, a jump from another tab. Null when nothing
 * reaches it.
 *
 * Breadth-first, so the route is the shortest one: a shared node sits at several
 * and none of them is more true than the others, so the one with the least depth
 * is the one a reader has to hold the least of in their head. Deliberately
 * separate from {@link resolveFocusPath}, which repairs a route the user already
 * took and must degrade to a prefix rather than silently re-route them.
 */
export function findPathTo(tree: ContainmentTree, id: NodeId): NodeId[] | null {
  if (id === tree.rootId) return [];
  const queue: NodeId[][] = [[]];
  const seen = new Set<NodeId>([tree.rootId]);
  while (queue.length) {
    const path = queue.shift()!;
    for (const link of tree.childrenOf.get(focusedId(tree, path)) ?? EMPTY) {
      if (seen.has(link.id)) continue;
      seen.add(link.id);
      const next = [...path, link.id];
      if (link.id === id) return next;
      queue.push(next);
    }
  }
  return null;
}

/**
 * The model one level renders: the focused node plus its children, and the edges
 * among them. The focused node is re-stamped `isRoot` so it reads as this
 * level's root — nothing above it is on screen, so it has no incoming edge to
 * socket and the root styling is what says "you are inside this".
 */
export function projectLevel(
  model: AppCanvasModel,
  tree: ContainmentTree,
  path: readonly NodeId[],
): AppCanvasModel {
  const focus = focusedId(tree, path);
  const visible = new Set<NodeId>([focus, ...childrenAt(tree, path).map((c) => c.id)]);
  const nodes = model.nodes
    .filter((n) => visible.has(n.name))
    .map((n) => (n.name === focus ? { ...n, isRoot: true } : n.isRoot ? { ...n, isRoot: false } : n));
  return {
    appName: model.appName,
    nodes,
    edges: model.edges.filter((e) => visible.has(e.from) && visible.has(e.to)),
    stripItems: model.stripItems,
  };
}

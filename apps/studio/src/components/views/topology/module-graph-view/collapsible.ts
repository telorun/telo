import type { GraphEdge, GraphNode, ModuleGraph } from "@telorun/analyzer";
import { railPorts } from "./box-geometry";
import { isPickerPort } from "./picker-port";
import { isRowDrawn } from "./row-tree";

/**
 * What can be collapsed, and what collapsing it hides.
 *
 * **The unit is a PROPERTY, not a box.** Collapsing a whole node said only
 * "show less of this", which on a canvas where every box is already visible
 * bought nothing: the boxes stayed, the edges stayed, and the reader had hidden
 * a list of rows they were probably reading. What a reader actually wants to put
 * away is a BRANCH — the mounts of a server, the steps of a sequence, the
 * not-found handler — and with it everything only that branch reaches.
 *
 * **Collapsible means it can carry a reference.** A property that holds no
 * reference hides nothing when collapsed, so offering the control would be
 * offering a gesture with no effect. `Http.Server` therefore has exactly two:
 * `mounts` and `notFoundHandler`.
 *
 * **Inside a branch, the rows are a TREE** — see `row-tree.ts`. A property owns
 * its body at every depth, and each row that nests carries a control of its own,
 * so a `while` is put away with its contents rather than beside them.
 */

/** The property a slot path belongs to: `mounts[].mount` → `mounts`,
 *  `notFoundHandler.invoke` → `notFoundHandler`. The top-level field is the
 *  unit a reader recognises — it is what the schema names and what the YAML
 *  indents under. */
export function propertyOf(slot: string): string {
  const marker = slot.search(/[.[{]/);
  return marker === -1 ? slot : slot.slice(0, marker);
}

/** One collapsible branch of a box. */
export interface CollapsibleProp {
  /** The top-level property name — its identity on this node. */
  key: string;
  /** Rows this property draws, in order. Empty for a property whose occupancy
   *  is a port rather than a list. */
  rows: GraphNode["rows"];
  /** Rail ports this property draws. Empty for one drawn entirely as rows. */
  ports: GraphNode["ports"];
  /** It can hold more entries — an ordered array rather than a single slot. */
  ordered: boolean;
}

/**
 * The branches of a box, in the order they are drawn: its rail ports first,
 * then its ordered arrays.
 *
 * A property appears once even when it is both — an entry list's handler slot
 * is row-owned, so the rows are what is drawn and the port is not repeated.
 */
export function collapsibleProps(node: GraphNode): CollapsibleProp[] {
  const byKey = new Map<string, CollapsibleProp>();
  const ensure = (key: string): CollapsibleProp => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const created: CollapsibleProp = { key, rows: [], ports: [], ordered: false };
    byKey.set(key, created);
    return created;
  };

  for (const port of railPorts(node)) ensure(propertyOf(port.slot)).ports.push(port);
  for (const array of node.rowArrays) ensure(array.field).ordered = true;
  // A nested row belongs to the branch its BODY hangs off, not to its own
  // array: `steps[1].do` is part of `steps`, and grouping by the concrete array
  // gave a `while`'s contents a branch of their own that no control reached.
  for (const row of node.rows) ensure(propertyOf(row.array)).rows.push(row);
  return [...byKey.values()];
}

/**
 * Does this branch earn a collapse control?
 *
 * Collapsing puts away what a branch REACHES. A branch that reaches nothing —
 * an unset slot, an array with no entries — hides nothing when collapsed, so
 * the chevron is a gesture with no effect, and it is spending the one column of
 * a box that a reader's eye starts at. A PICKED branch reaches nothing to hide
 * either: an ambient hold is drawn as the name it holds, never as an edge, so
 * there is no fan-out below it to put away.
 *
 * An uncollapsible branch is always drawn OPEN — {@link boxLines} and the
 * renderer both ask here, and a branch whose control is gone must not be able
 * to stay shut on a state key nothing can now clear. That also keeps an empty
 * ordered array's "add" affordance reachable, which is the only thing in it.
 */
export function isCollapsible(prop: CollapsibleProp): boolean {
  if (prop.rows.length > 0) return true;
  if (prop.ports.length > 0 && prop.ports.every(isPickerPort)) return false;
  return prop.ports.some((port) => port.slots.some((slot) => slot.target || slot.inline));
}

/** Key for one collapsed branch. A node id already contains a NUL, so the
 *  separator only has to distinguish the property from it. */
export const propKey = (nodeId: string, property: string): string => `${nodeId}${property}`;

export interface VisibilityInput {
  graph: ModuleGraph;
  /** The edges the view would otherwise draw. */
  drawn: readonly GraphEdge[];
  /** Whether this box's branch is collapsed. */
  isCollapsed: (nodeId: string, property: string) => boolean;
}

export interface Visibility {
  /** Nodes to draw. */
  nodes: ReadonlySet<string>;
  /** Edges to draw — those from an open branch, between two visible nodes. */
  edges: readonly GraphEdge[];
}

/**
 * What is left visible once branches are collapsed.
 *
 * A node disappears when **everything that reached it is gone**: it has
 * incoming edges, and every one of them either leaves a collapsed branch or
 * comes from a node that has itself disappeared. That second clause is what
 * makes collapsing a branch put away the whole branch rather than its first
 * step, and it is a fixpoint rather than one pass because hiding a node can be
 * the last thing that was holding its own callees on screen.
 *
 * A node NOTHING references stays — an unwired declaration, a provider held
 * only through a collapsed chip, the module root. Hiding those would make a
 * collapse elsewhere silently remove a resource the reader never linked to it.
 */
export function resolveVisibility({ graph, drawn, isCollapsed }: VisibilityInput): Visibility {
  // A step's edge leaves a ROW, so the branch it comes from is shut when the
  // property is — or when any row above it is. Without the second clause,
  // putting away a loop left everything its body called still on the canvas.
  const fromOpenBranch = (edge: GraphEdge): boolean => {
    if (isCollapsed(edge.from, propertyOf(edge.slot))) return false;
    if (!edge.row) return true;
    const rows = graph.nodeById(edge.from)?.rows ?? [];
    return isRowDrawn(rows, edge.row, (rowId) => !isCollapsed(edge.from, rowId));
  };

  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of drawn) {
    if (!edge.to) continue;
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  }

  const hidden = new Set<string>();
  for (;;) {
    let changed = false;
    for (const node of graph.nodes) {
      if (hidden.has(node.id) || node.root) continue;
      const arrivals = incoming.get(node.id);
      if (!arrivals || arrivals.length === 0) continue;
      const reachable = arrivals.some((e) => fromOpenBranch(e) && !hidden.has(e.from));
      if (!reachable) {
        hidden.add(node.id);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // An owned declaration is drawn inside its owner, so it goes when the owner
  // does — it has nowhere else to be.
  for (const node of graph.nodes) {
    if (node.owner && hidden.has(node.owner)) hidden.add(node.id);
  }

  const nodes = new Set(graph.nodes.filter((n) => !hidden.has(n.id)).map((n) => n.id));
  return {
    nodes,
    edges: drawn.filter(
      (e) => fromOpenBranch(e) && nodes.has(e.from) && (!e.to || nodes.has(e.to)),
    ),
  };
}

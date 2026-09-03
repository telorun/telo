import {
  isAmbientCapability,
  type GraphEdge,
  type GraphNode,
  type ModuleGraph,
} from "@telorun/analyzer";

/**
 * Declarations that are NOT on the canvas.
 *
 * A connection, a store, a font, a named shape is held and read rather than
 * run: every relation reaching one is a hold or a type annotation, neither of
 * which the canvas draws — a hold collapses to the name in its holder's picker,
 * and a `shape` slot names a type with no runtime relation at all. So these
 * arrived as boxes with no line at either end, sitting in a column of their own
 * and saying nothing a reader could not read off the holder. In one shipped app
 * they were three of three resources; across the examples they are a quarter to
 * a third.
 *
 * They keep their place in the editor, as groups of the module drawer beside the
 * canvas. Both still select, and selecting one rings every box that reaches it —
 * which is the relation the canvas was spending a box and a column to state.
 *
 * **For an ambient hold the test is a drawn EDGE, not a capability**, and that
 * is what keeps the canvas connected: `Ai.Model` declares
 * `capability: Telo.Provider` and is genuinely CALLED, so a line runs to it and
 * it stays. Removing by capability alone would leave that line pointing at
 * nothing.
 *
 * **An IMPORTED instance leaves unconditionally**, and that is a different rule
 * for a different reason. It is not this module's declaration: it is configured,
 * versioned and edited in the library that wrote it, and there is nothing to do
 * to it here beyond point at it. Drawn as a peer it competed for the canvas with
 * the module's own resources while offering none of a box's affordances — the
 * two `Console` handlers in a five-line application were two of its three boxes.
 * What a reader wants of one is its name and what reaches it, which is what the
 * drawer row and its ring say. The reference itself is not lost: a row states
 * the name it dispatches to, and a held slot states the name it holds.
 */

/** Capabilities whose resources are ambient — held and read rather than run. */
/** Re-exported, never re-declared: the analyzer owns which capabilities are
 *  ambient, and it is the same fact `isAmbientHold` collapses an edge on. Two
 *  copies is how the drawer files a box the canvas still draws a line to. */
export { AMBIENT_CAPABILITIES } from "@telorun/analyzer";

export interface OffCanvas {
  /** `Telo.Type` instances — a named shape, which has no runtime existence. */
  types: GraphNode[];
  /** `Telo.Provider` instances — held, never run. */
  providers: GraphNode[];
  /** Instances declared in another module and reached across an import. */
  imported: GraphNode[];
  /** Every id in the three, for subtracting from what the layout is given. */
  ids: ReadonlySet<string>;
}

/**
 * An instance this module reaches but did not declare.
 *
 * Asked on its own as well as through {@link offCanvasNodes}, because the edge
 * set is decided BEFORE the split — an edge into one is summarised at its source
 * the way an ambient hold is, and that has to be known without the drawn set
 * this function is otherwise given.
 */
export function isImportedInstance(node: GraphNode): boolean {
  if (node.root || node.ownership === "inline" || node.ownership === "scoped") return false;
  return !!node.external;
}

/**
 * Split the declarations that are not boxes off the drawn set.
 *
 * An OWNED declaration is never here: an inline or `with:`-scoped resource is
 * drawn inside its owner and has nowhere else to be. Nor is the module root.
 *
 * Imported first: an imported instance is filed under what it borrows from,
 * whatever its capability, so one instance does not change group according to
 * whether something happens to call it.
 */
export function offCanvasNodes(graph: ModuleGraph, drawn: readonly GraphEdge[]): OffCanvas {
  const touched = new Set<string>();
  for (const edge of drawn) {
    touched.add(edge.from);
    if (edge.to) touched.add(edge.to);
  }

  const types: GraphNode[] = [];
  const providers: GraphNode[] = [];
  const imported: GraphNode[] = [];
  for (const node of graph.nodes) {
    if (node.root || node.ownership === "inline" || node.ownership === "scoped") continue;
    if (isImportedInstance(node)) {
      imported.push(node);
      continue;
    }
    if (!isAmbientCapability(node.capability)) continue;
    if (touched.has(node.id)) continue;
    (node.capability === "Telo.Type" ? types : providers).push(node);
  }
  return {
    types,
    providers,
    imported,
    ids: new Set([...types, ...providers, ...imported].map((n) => n.id)),
  };
}

/**
 * Boxes that reach the selected declaration.
 *
 * The ring is what replaces the line: an off-canvas declaration is selected in
 * its drawer, and every box holding it says so. Read off EVERY edge, drawn or
 * not — a hold that was collapsed to a picker is exactly the relation being
 * asked about, so restricting to drawn edges would answer nothing.
 */
export function nodesReaching(graph: ModuleGraph, selectedId: string | undefined): Set<string> {
  if (!selectedId) return new Set();
  return new Set(graph.edgesTo(selectedId).map((edge) => edge.from));
}

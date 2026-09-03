import type { GraphKind, GraphNode, ModuleGraph } from "@telorun/analyzer";
import { isImportedInstance, type OffCanvas } from "./off-canvas";

/**
 * What the drawer lists: everything the module has that is not one of its own
 * boxes.
 *
 * Four groups, and the split is by WHY a thing is not a box rather than by what
 * it is. **Providers** and **types** are off the canvas because nothing draws a
 * line to them — a hold collapses to the name in its holder's picker, and a
 * `shape` slot names a type with no runtime relation at all (see
 * `off-canvas.ts`). **Kinds** and **resources** are listed because they were
 * declared somewhere else: an imported kind has no instance here to draw, and an
 * imported instance is one this module reaches but did not write, so the drawer
 * is the index of what this module borrows.
 *
 * All four have LEFT the canvas, and selecting any of them rings what reaches
 * it — the ring is what stands in for the line.
 *
 * **A module's own kinds are listed only when the drawer IS the canvas.** The
 * group is imported kinds by declaration; a module that declares kinds and no
 * instances has no other surface at all, so its own are listed there rather than
 * leaving it a blank panel.
 */
export interface DrawerGroups {
  /** Held, never run — off the canvas. */
  providers: GraphNode[];
  /** Named shapes: no runtime instance, so no box either. */
  types: GraphNode[];
  /** Kind declarations reached across an import — plus this module's own when
   *  there is no canvas to put anything else on. */
  kinds: GraphKind[];
  /** Instances declared in another module and reached from here. */
  resources: GraphNode[];
}

export interface DrawerGroupsInput {
  graph: ModuleGraph;
  offCanvas: OffCanvas;
  /** True when the module declares no boxes, so this drawer is the canvas. */
  sole: boolean;
}

export function drawerGroups({ graph, offCanvas, sole }: DrawerGroupsInput): DrawerGroups {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    providers: [...offCanvas.providers].sort(byName),
    types: [...offCanvas.types].sort(byName),
    kinds: graph.kinds.filter((kind) => !kind.own || sole),
    resources: [...offCanvas.imported].sort(byName),
  };
}

/**
 * Is the kind plane this module's whole content — so the drawer takes the
 * surface and there is no canvas?
 *
 * **A claim about what the module HAS, not about what the canvas lacks.** An
 * empty application has no instance boxes either, and reading that as "kind
 * only" handed the whole tab to a drawer which then, having no kinds to list,
 * rendered nothing at all: a blank canvas for a manifest whose root is
 * perfectly drawable — and the state every new module starts in.
 *
 * So it takes a kind of the module's OWN. A module with neither instances nor
 * kinds is empty, and an empty module still draws its root, which is where its
 * boot list and the control that adds the first target live.
 *
 * **An imported instance is not a box and still counts as content**, which is
 * the one place the two questions come apart. A module wiring libraries together
 * declares almost nothing of its own, so reading "no boxes" as "kinds are all
 * there is" would take away the root — and the root is where the boot list is,
 * which for that module IS the application.
 */
export function kindPlaneIsSoleContent(
  graph: ModuleGraph,
  offCanvas: ReadonlySet<string>,
): boolean {
  if (!graph.kinds.some((kind) => kind.own)) return false;
  return graph.nodes.every(
    (node) => node.root || (offCanvas.has(node.id) && !isImportedInstance(node)),
  );
}

/** Nothing to show — the drawer draws no chrome at all. */
export function isEmpty(groups: DrawerGroups): boolean {
  return (
    groups.providers.length === 0 &&
    groups.types.length === 0 &&
    groups.kinds.length === 0 &&
    groups.resources.length === 0
  );
}

/** How many rows the drawer holds, for the count on its closed handle. */
export function groupTotal(groups: DrawerGroups): number {
  return (
    groups.providers.length + groups.types.length + groups.kinds.length + groups.resources.length
  );
}

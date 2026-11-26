import type { GraphKind, GraphNode, ModuleGraph } from "@telorun/analyzer";
import { isImportedInstance, type OffCanvas } from "./off-canvas";

/**
 * What the drawer lists: everything the module has that is not one of its own
 * boxes.
 *
 * Groups, and the split is by WHY a thing is not a box rather than by what
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
 * **Imported kinds and instances are filed under the import's alias**, never
 * mixed with this module's own groups. **A module's own kinds are listed only
 * when the drawer IS the canvas.** A module that declares kinds and no
 * instances has no other surface at all, so its own are listed there rather than
 * leaving it a blank panel.
 */
export interface DrawerGroups {
  /** Held, never run — off the canvas. */
  providers: GraphNode[];
  /** Named shapes: no runtime instance, so no box either. */
  types: GraphNode[];
  /** This module's own kinds — listed only when there is no canvas to put
   *  anything else on. */
  kinds: GraphKind[];
  /** What each imported module contributes — its kinds and the instances it
   *  declared that this module reaches — filed under the import's alias. */
  imports: ImportGroup[];
}

export interface ImportGroup {
  /** The alias this module writes the import with. */
  alias: string;
  kinds: GraphKind[];
  resources: GraphNode[];
}

export interface DrawerGroupsInput {
  graph: ModuleGraph;
  offCanvas: OffCanvas;
  /** True when the module declares no boxes, so this drawer is the canvas. */
  sole: boolean;
}

/** The alias each declaring module is imported under, read off the instances
 *  the graph already stamps with one. */
function aliasesByModule(graph: ModuleGraph): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.external && node.module && node.alias) aliases.set(node.module, node.alias);
  }
  return aliases;
}

const moduleOfKind = (kind: GraphKind): string => {
  if (kind.module) return kind.module;
  const dot = kind.id.lastIndexOf(".");
  return dot > 0 ? kind.id.slice(0, dot) : kind.id;
};

export function drawerGroups({ graph, offCanvas, sole }: DrawerGroupsInput): DrawerGroups {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const aliases = aliasesByModule(graph);
  const groups = new Map<string, ImportGroup>();
  const groupFor = (module: string | undefined): ImportGroup => {
    const key = module ?? "";
    let group = groups.get(key);
    if (!group) {
      group = { alias: (module && aliases.get(module)) || module || "imports", kinds: [], resources: [] };
      groups.set(key, group);
    }
    return group;
  };
  for (const kind of graph.kinds) if (!kind.own) groupFor(moduleOfKind(kind)).kinds.push(kind);
  for (const node of [...offCanvas.imported].sort(byName)) groupFor(node.module).resources.push(node);
  return {
    providers: [...offCanvas.providers].sort(byName),
    types: [...offCanvas.types].sort(byName),
    kinds: sole ? graph.kinds.filter((kind) => kind.own) : [],
    imports: [...groups.values()].sort((a, b) => a.alias.localeCompare(b.alias)),
  };
}

/**
 * A kind as THIS module would write it. An instance a library declares carries
 * the library's own spelling (`Self.WriteLine`); an importer writes it through
 * the alias it imported the library under.
 */
export function kindAsWritten(graph: ModuleGraph, node: GraphNode): string {
  if (node.unknownKind || !node.external) return node.kind;
  const canonical = node.canonicalKind ?? node.kind;
  const dot = canonical.lastIndexOf(".");
  if (dot <= 0) return canonical;
  const module = canonical.slice(0, dot);
  const alias = node.alias ?? aliasesByModule(graph).get(module) ?? module;
  return `${alias}.${canonical.slice(dot + 1)}`;
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
 * kinds is empty, and keeps its (empty) canvas. The module root never counts:
 * it is not a box, and what it declares is in the module bar.
 *
 * **An imported instance is not a box and still counts as content**, which is
 * the one place the two questions come apart. A module wiring libraries together
 * declares almost nothing of its own, so reading "no boxes" as "kinds are all
 * there is" would hand the tab to the drawer for what is an application.
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
    groups.imports.length === 0
  );
}

/** How many rows the drawer holds, for the count on its closed handle. */
export function groupTotal(groups: DrawerGroups): number {
  return (
    groups.providers.length +
    groups.types.length +
    groups.kinds.length +
    groups.imports.reduce((sum, group) => sum + group.kinds.length + group.resources.length, 0)
  );
}

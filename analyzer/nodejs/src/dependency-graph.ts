import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { buildCallGraph, projectToPairs, type ResourceGraphNode } from "./call-graph.js";
import type { DefinitionRegistry } from "./definition-registry.js";

export interface ResourceNode {
  kind: string;
  name: string;
}

export interface DependencyGraph {
  /** Topological order: each resource appears after all its dependencies (leaves first).
   *  Present only when the graph is acyclic. */
  order?: ReadonlyArray<ResourceNode>;
  /** The cycle path when a circular dependency is detected.
   *  The first and last elements are the same resource, tracing the full loop. */
  cycle?: ReadonlyArray<ResourceNode>;
}

const nodeKey = (kind: string, name: string) => `${kind}\0${name}`;

/**
 * Builds a directed acyclic graph (DAG) of boot-time resource dependencies and
 * returns either a topological initialization order or the cycle path.
 *
 * A projection of the typed reference graph, not a second walk of the manifest.
 * What this consumer keeps of the full graph:
 *
 * - **Injection sites only.** A site the reference field map reaches is a
 *   Phase-5 injection site, so its target must be constructed first — including
 *   `Telo.Application`'s inline `targets[].invoke`, which is step-declared but
 *   injected. A step slot behind a local `$ref` and a value-tree-discovered ref
 *   resolve at dispatch, so their targets need only exist by the time the step
 *   runs. All can be `use: call` — the difference is the site, never the node
 *   kind or the use.
 * - **Every use but `schema`.** A `Telo.Type` slot names a shape; no runtime
 *   instance is constructed, so there is nothing to order against.
 * - **No edge into the source's own scope.** A scoped resource is created when
 *   the scope opens, not at boot.
 * - **Pairs, not parallel edges.** This is the one consumer for which two slots
 *   naming the same target genuinely mean the same thing, so it collapses the
 *   multigraph itself instead of the graph erasing the distinction for everyone.
 */
export function buildDependencyGraph(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
): DependencyGraph {
  const graph = buildCallGraph(resources, registry, { aliases, aliasesByModule });

  const nodes = new Map<string, ResourceNode>();
  for (const node of graph.nodes.values()) {
    if (node.type !== "resource") continue;
    const resource = node as ResourceGraphNode;
    // A scope-declared resource is created when its scope opens, never at boot.
    if (resource.scoped) continue;
    nodes.set(resource.id, { kind: resource.kind, name: resource.name });
  }

  const deps = projectToPairs(graph, {
    keepUse: (use) => use.length === 0 || use.some((u) => u !== "schema"),
  });
  for (const edge of graph.edges) {
    if (!edge.scoped || !edge.to) continue;
    deps.get(edge.from)?.delete(edge.to);
  }
  for (const key of nodes.keys()) if (!deps.has(key)) deps.set(key, new Set());

  // --- Kahn's topological sort ---
  // in-degree[X] = number of X's dependencies (size of deps[X])
  // reverse[dep] = set of nodes that depend on dep (for degree decrement)
  const inDegree = new Map<string, number>();
  const reverse = new Map<string, Set<string>>();
  for (const key of nodes.keys()) {
    inDegree.set(key, deps.get(key)!.size);
    reverse.set(key, new Set());
  }
  for (const [from, depSet] of deps) {
    for (const dep of depSet) {
      reverse.get(dep)?.add(from);
    }
  }

  const queue: string[] = [];
  for (const [key, deg] of inDegree) {
    if (deg === 0) queue.push(key);
  }

  const sorted: ResourceNode[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    sorted.push(nodes.get(key)!);
    for (const dependent of reverse.get(key)!) {
      const deg = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, deg);
      if (deg === 0) queue.push(dependent);
    }
  }

  if (sorted.length === nodes.size) {
    return { order: sorted };
  }

  return { cycle: findCycle(nodes, deps) };
}

/**
 * Formats a cycle result into a human-readable error string matching the spec:
 *
 *   Circular dependency detected:
 *     Run.Sequence "DataSync"
 *       → Http.Server "Api"
 *       → Run.Sequence "DataSync"
 */
export function formatCycle(cycle: ReadonlyArray<ResourceNode>): string {
  const lines = ["Circular dependency detected:"];
  lines.push(`  ${cycle[0].kind} "${cycle[0].name}"`);
  for (const node of cycle.slice(1)) {
    lines.push(`    → ${node.kind} "${node.name}"`);
  }
  return lines.join("\n");
}

// --- Internals ---

/** DFS cycle detection — returns the cycle path with the repeated start node appended. */
function findCycle(
  nodes: Map<string, ResourceNode>,
  deps: Map<string, Set<string>>,
): ResourceNode[] {
  type State = "unvisited" | "visiting" | "visited";
  const state = new Map<string, State>();
  for (const key of nodes.keys()) state.set(key, "unvisited");

  const stack: string[] = [];

  function dfs(key: string): string[] | null {
    state.set(key, "visiting");
    stack.push(key);

    for (const dep of deps.get(key) ?? []) {
      if (state.get(dep) === "visiting") {
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep];
      }
      if (state.get(dep) === "unvisited") {
        const result = dfs(dep);
        if (result) return result;
      }
    }

    stack.pop();
    state.set(key, "visited");
    return null;
  }

  for (const key of nodes.keys()) {
    if (state.get(key) === "unvisited") {
      const result = dfs(key);
      if (result) return result.map((k) => nodes.get(k)!);
    }
  }

  return [];
}

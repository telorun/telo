import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { visitManifest } from "./manifest-visitor.js";
import { DEPENDENCY_GRAPH_SKIP_KINDS as SYSTEM_KINDS } from "./system-kinds.js";

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
 * Builds a directed acyclic graph (DAG) of runtime resource dependencies and
 * returns either a topological initialization order or the cycle path.
 *
 * Edges represent boot-time dependencies only:
 * - x-telo-ref fields that fall within a scope visibility path are excluded
 *   (scoped resources are initialized on demand at runtime, not at boot).
 * - x-telo-scope fields themselves are excluded from the graph.
 *
 * The registry is queried for each resource's field map by kind — callers do
 * not pre-compute or pass field maps separately.
 */
export function buildDependencyGraph(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
): DependencyGraph {
  // --- Build node set + name index ---
  const nodes = new Map<string, ResourceNode>();
  // Sentinel lookup (`!ref <name>`) needs to resolve a bare name to its
  // declared kind. Names are unique within a manifest scope, so a flat
  // map suffices and lets the sentinel branch below avoid a full
  // O(N) scan of the node set on every reference.
  const nodesByName = new Map<string, ResourceNode>();
  for (const r of resources) {
    if (!r.metadata?.name || !r.kind || SYSTEM_KINDS.has(r.kind)) continue;
    const node = { kind: r.kind, name: r.metadata.name as string };
    nodes.set(nodeKey(node.kind, node.name), node);
    nodesByName.set(node.name, node);
  }

  // --- Build adjacency: from → deps (from depends on dep) ---
  const deps = new Map<string, Set<string>>();
  for (const key of nodes.keys()) deps.set(key, new Set());

  // Names of resources declared inside the *current* resource's scope fields —
  // initialized on-demand at runtime, not at boot, so edges pointing to them
  // are excluded. Scoping is per-source-resource: an edge A → B is dropped only
  // when B is declared inside A's own scope (the visitor's ScopeBoundary fires
  // before that resource's RefSites, so this is set before any edge is added).
  let scopedNames = new Set<string>();

  // Expanded map so refs nested behind x-telo-schema-from contribute edges to
  // the DAG. Without these, a parent (e.g. Http.Server) can init before its
  // extracted encoder and Phase 5 injection fires against a not-yet-created
  // dependency.
  visitManifest(
    resources,
    registry,
    {
      onScope: (e) => {
        scopedNames = e.enclosedNames;
      },
      onRef: (e) => {
        const sourceKey = nodeKey(e.source.kind, e.source.metadata!.name as string);
        const val = e.value;

        // `!ref <name>` sentinel — look up the target's kind from the name
        // (resources are unique by name) so the edge carries the concrete kind,
        // matching the {kind, name} edge shape below.
        if (isRefSentinel(val)) {
          const refName = val.source;
          if (scopedNames.has(refName)) return;
          const node = nodesByName.get(refName);
          if (node) deps.get(sourceKey)!.add(nodeKey(node.kind, node.name));
          return;
        }

        if (typeof val !== "object") return;
        const ref = val as Record<string, unknown>;
        if (!ref.kind || !ref.name) return;
        if (scopedNames.has(ref.name as string)) return;
        const targetKey = nodeKey(ref.kind as string, ref.name as string);
        if (nodes.has(targetKey)) deps.get(sourceKey)!.add(targetKey);
      },
    },
    { aliases, aliasesByModule, skipKinds: SYSTEM_KINDS, expand: true },
  );

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

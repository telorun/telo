import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isRefEntry, isScopeEntry } from "./reference-field-map.js";

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

/** System resource kinds that are not runtime nodes in the dependency graph. */
const SYSTEM_KINDS = new Set(["Kernel.Definition", "Kernel.Import"]);

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
): DependencyGraph {
  // --- Build node set ---
  const nodes = new Map<string, ResourceNode>();
  for (const r of resources) {
    if (!r.metadata?.name || !r.kind || SYSTEM_KINDS.has(r.kind)) continue;
    const key = nodeKey(r.kind, r.metadata.name as string);
    nodes.set(key, { kind: r.kind, name: r.metadata.name as string });
  }

  // --- Build adjacency: from → deps (from depends on dep) ---
  const deps = new Map<string, Set<string>>();
  for (const key of nodes.keys()) deps.set(key, new Set());

  for (const r of resources) {
    if (!r.metadata?.name || !r.kind || SYSTEM_KINDS.has(r.kind)) continue;

    const sourceKey = nodeKey(r.kind, r.metadata.name as string);
    const resolvedKind = aliases?.resolveKind(r.kind);
    const fieldMap =
      registry.getFieldMap(r.kind) ??
      (resolvedKind ? registry.getFieldMap(resolvedKind) : undefined);
    if (!fieldMap) continue;

    // Collect names of resources declared inside scope fields — these are initialized
    // on-demand at runtime, not at boot, so edges pointing to them are excluded from the DAG.
    const scopedNames = new Set<string>();
    for (const [scopeFieldPath, entry] of fieldMap) {
      if (!isScopeEntry(entry)) continue;
      const scopeVal = (r as Record<string, unknown>)[scopeFieldPath];
      if (!Array.isArray(scopeVal)) continue;
      for (const item of scopeVal) {
        const name = (item as any)?.metadata?.name;
        if (typeof name === "string") scopedNames.add(name);
      }
    }

    for (const [fieldPath, entry] of fieldMap) {
      if (!isRefEntry(entry)) continue;

      for (const val of resolveFieldValues(r, fieldPath)) {
        if (!val || typeof val !== "object" || !val.kind || !val.name) continue;
        // Edges to scoped resources are runtime deps, not boot-time deps — exclude from DAG
        if (scopedNames.has(val.name as string)) continue;
        const targetKey = nodeKey(val.kind as string, val.name as string);
        if (nodes.has(targetKey)) {
          deps.get(sourceKey)!.add(targetKey);
        }
      }
    }
  }

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

/** Resolves all values at a field map path in a resource config.
 *  `[]` in a path segment means "iterate array at this key". */
function resolveFieldValues(obj: any, path: string): any[] {
  const parts = path.split(".");
  let current: any[] = [obj];

  for (const part of parts) {
    const isArray = part.endsWith("[]");
    const key = isArray ? part.slice(0, -2) : part;
    const next: any[] = [];

    for (const item of current) {
      if (!item || typeof item !== "object") continue;
      const val = item[key];
      if (val == null) continue;
      if (isArray && Array.isArray(val)) {
        next.push(...val);
      } else if (!isArray) {
        next.push(val);
      }
    }

    current = next;
  }

  return current;
}

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

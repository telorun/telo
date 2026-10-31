import type { ResourceManifest } from "@telorun/sdk";
import { isKindDocument } from "./kind-declaration.js";
import type { AliasResolver } from "./alias-resolver.js";
import {
  buildCallGraph,
  nodeIdFor,
  projectToPairs,
  type CallGraph,
  type ResourceGraphNode,
} from "./call-graph.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { governedCelEvalSites } from "./eval-paths.js";
import type { DefResolver } from "./extends-resolution.js";
import { definitionInScope, moduleAliasScope } from "./module-alias-scope.js";
import { isModuleKind } from "./module-kinds.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { readSuppliedResources } from "./resource-input.js";
import { needSupplyOf, readSuppliedNeeds } from "./need-type.js";
import { celResourceReads } from "./cel-access-chains.js";
import { startupObservedStateReads } from "./validate-observed-state.js";
import { isResolvedReference } from "./resolved-reference.js";
import { ScopedNameResolver, type DeclarationReading } from "./scoped-name-resolver.js";

/** How a keyed node names itself and the module that declared it. */
const KEYED_NODE_READING: DeclarationReading<[string, ResourceNode]> = {
  nameOf: ([, node]) => node.name,
  moduleOf: ([, node]) => declaringModuleOf(node.manifest),
};

export interface ResourceNode {
  kind: string;
  name: string;
  /** The declaration this node was built from. */
  manifest: ResourceManifest;
}

export interface DependencyGraph {
  /** Topological order: each resource appears after all its dependencies (leaves first).
   *  Present only when the graph is acyclic. */
  order?: ReadonlyArray<ResourceNode>;
  /** The cycle path when a circular dependency is detected.
   *  The first and last elements are the same resource, tracing the full loop. */
  cycle?: ReadonlyArray<ResourceNode>;
  /** One cycle path per strongly connected component that loops, `cycle` among
   *  them — so disjoint loops are each reported. Present iff `cycle` is. */
  cycles?: ReadonlyArray<ReadonlyArray<ResourceNode>>;
}

/**
 * Builds a directed acyclic graph (DAG) of boot-time resource dependencies and
 * returns either a topological initialization order or the cycle path.
 *
 * A projection of the typed reference graph, not a second walk of the manifest.
 * What this consumer keeps of the full graph:
 *
 * - **Injection sites only.** A site the reference reach reaches is a
 *   Phase-5 injection site, so its target must be constructed first — including
 *   `Telo.Application`'s inline `targets[].invoke`, which is step-declared but
 *   injected. A step slot in a step body and a value-tree-discovered ref
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
 * - **Startup reads of observed state.** A compile-eval field reading
 *   `resources.<name>.status` is evaluated when the reader is created, so the
 *   producer — a Provider, which reports from `init()` — is initialized first.
 *   A read across an import orders the reader after that import.
 */
export function buildDependencyGraph(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
  callGraph?: CallGraph,
): DependencyGraph {
  const graph = callGraph ?? buildCallGraph(resources, registry, { aliases, aliasesByModule });

  const nodes = new Map<string, ResourceNode>();
  for (const node of graph.nodes.values()) {
    if (node.type !== "resource") continue;
    const resource = node as ResourceGraphNode;
    // A scope-declared resource is created when its scope opens, never at boot.
    if (resource.scoped) continue;
    nodes.set(resource.id, {
      kind: resource.kind,
      name: resource.name,
      manifest: resource.manifest,
    });
  }

  const deps = projectToPairs(graph, {
    keepUse: (use) => use.length === 0 || use.some((u) => u !== "schema"),
  });
  for (const edge of graph.edges) {
    if (!edge.scoped || !edge.to) continue;
    deps.get(edge.from)?.delete(edge.to);
  }
  for (const key of nodes.keys()) if (!deps.has(key)) deps.set(key, new Set());

  const importNodes = addImportNodes(resources, nodes, deps, aliases, aliasesByModule);
  addResourceInputEdges(importNodes, nodes, deps);
  addImportReferenceEdges(graph, nodes, deps, importNodes, aliases, aliasesByModule);
  addStartupStatusReadEdges(nodes, deps, registry, aliases, aliasesByModule, importNodes);

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
    return {
      order: creationOrder(resources, nodes, deps, aliases, aliasesByModule),
    };
  }

  const cycleKeys = findCycle(nodes.keys(), deps);
  const toNodes = (keys: string[]) => keys.map((k) => nodes.get(k)!);
  const cycles = stronglyConnectedLoops(nodes, deps).map((component) =>
    component.has(cycleKeys[0]!)
      ? cycleKeys
      : findCycle(component, deps, component),
  );
  return { cycle: toNodes(cycleKeys), cycles: cycles.map(toNodes) };
}

/**
 * The loops among one scope's members, each scope on its own: the kernel
 * creates a scope's members when the scope opens, in an init loop of their own,
 * so a member holding a sibling that holds it back can never be created. Read
 * off the same reference edges as the boot order — a member's reference slots,
 * never its steps, every use but `schema` — kept to edges between members of
 * one scope, since anything else exists before the scope opens.
 */
export function scopedCycles(graph: CallGraph): ReadonlyArray<ReadonlyArray<ResourceNode>> {
  const groups = new Map<string, Map<string, ResourceNode>>();
  const groupOf = new Map<string, string>();
  for (const node of graph.nodes.values()) {
    if (node.type !== "resource" || !node.scoped) continue;
    const key = `${node.scopeOwner ?? ""}\0${node.scopeSite ?? ""}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = new Map()));
    group.set(node.id, { kind: node.kind, name: node.name, manifest: node.manifest });
    groupOf.set(node.id, key);
  }
  if (groups.size === 0) return [];
  const deps = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!edge.to || edge.nested || edge.moduleCall) continue;
    if (edge.use.length > 0 && edge.use.every((use) => use === "schema")) continue;
    const group = groupOf.get(edge.from);
    if (group === undefined || groupOf.get(edge.to) !== group) continue;
    let set = deps.get(edge.from);
    if (!set) deps.set(edge.from, (set = new Set()));
    set.add(edge.to);
  }
  const out: ResourceNode[][] = [];
  for (const nodes of groups.values()) {
    for (const component of stronglyConnectedLoops(nodes, deps)) {
      out.push(findCycle(component, deps, component).map((key) => nodes.get(key)!));
    }
  }
  return out;
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
  const through = cycle.find((node) => node.kind === "Telo.Import");
  if (through) {
    lines.push(
      `Import '${through.name}' initializes after the resources it is handed, and an instance it ` +
        `exports exists only once it has initialized — so a resource handed to it cannot hold one ` +
        `of its exports. Move what is exported into a module that borrows nothing from the importer.`,
    );
  }
  return lines.join("\n");
}

// --- Internals ---



/**
 * The order resources are created in: the dependency order, with the
 * declarations a resource's kind is spelled through placed before it.
 *
 * `kind: Http.Api` is created against the alias its `Telo.Import` registers,
 * and `kind: Self.Page` against the `Telo.Definition` that declares `Page`;
 * a definition's `extends:` resolves the same way. Neither is a dependency
 * edge — an import or a definition is not a boot-time resource — so without
 * this they sorted after everything and every such resource failed its first
 * creation attempt.
 *
 * A reference written through an import alias at a step's `invoke:` orders the
 * same way: the target's declaration exists only once its import is created,
 * and the kernel reads a call site's plain-encoded literals against that
 * declaration when it creates the resource holding the call. (One at a
 * resource's own reference slot is a hard edge already — see
 * {@link addImportReferenceEdges}.)
 *
 * These are SOFT edges: they order, and never fail. An import may be handed an
 * instance of a kind it itself exports (`resources: { conn: !ref db }` where
 * `db` is `kind: Lib.Connection`), which the runtime satisfies because the
 * alias exists once the import is created; as a hard edge that would be a
 * cycle. A step is dispatched only once everything has initialized, so a step
 * calling an export of an import its holder is supplied to is no cycle either.
 * So cycle detection stays on the dependency edges alone, and when only soft
 * edges hold the sort back, the first node whose dependencies are all met goes
 * next.
 *
 * Both ends are read through {@link moduleAliasScope}: an import is keyed by the
 * alias table it registers into, and a kind by the table its declaring module
 * resolves in — so the two meet exactly when the kind is spelled through that
 * import, and a definition is matched by the canonical kind the table yields.
 */
function creationOrder(
  resources: ResourceManifest[],
  nodes: Map<string, ResourceNode>,
  deps: Map<string, Set<string>>,
  aliases: AliasResolver | undefined,
  aliasesByModule: Map<string, AliasResolver> | undefined,
): ResourceNode[] {
  const keyOf = new Map<ResourceManifest, string>();
  for (const [key, node] of nodes) keyOf.set(node.manifest, key);

  // Manifest order, so resources with nothing between them keep the order
  // they were written in.
  const all = new Map<string, ResourceNode>();
  const importsByScope = new Map<AliasResolver | undefined, Map<string, string>>();
  const definitions = new Map<string, string>();
  const scopeOf = (m: ResourceManifest) => moduleAliasScope(m.metadata, aliases, aliasesByModule);
  for (const m of resources) {
    const name = m.metadata?.name;
    if (typeof name !== "string" || typeof m.kind !== "string" || isModuleKind(m.kind)) continue;
    let key = keyOf.get(m);
    if (key === undefined) {
      if (m.kind !== "Telo.Import" && !isKindDocument(m)) continue;
      key = nodeIdFor(m);
    }
    if (!all.has(key)) all.set(key, nodes.get(key) ?? { kind: m.kind, name, manifest: m });
    if (m.kind === "Telo.Import") {
      const scope = scopeOf(m);
      let imports = importsByScope.get(scope);
      if (!imports) importsByScope.set(scope, (imports = new Map()));
      imports.set(name, key);
    } else if (isKindDocument(m)) {
      const module = declaringModuleOf(m);
      if (module) definitions.set(`${module}.${name}`, key);
    }
  }
  for (const [key, node] of nodes) if (!all.has(key)) all.set(key, node);

  const declarationOf = (
    kind: unknown,
    scope: AliasResolver | undefined,
  ): string | undefined => {
    if (typeof kind !== "string") return undefined;
    const dot = kind.indexOf(".");
    if (dot <= 0) return undefined;
    return (
      importsByScope.get(scope)?.get(kind.slice(0, dot)) ??
      definitions.get(scope?.resolveKind(kind) ?? kind)
    );
  };

  const unmet = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const [key, node] of all) {
    const set = new Set([...(deps.get(key) ?? [])].filter((d) => all.has(d)));
    const scope = scopeOf(node.manifest);
    for (const declared of [node.manifest.kind, (node.manifest as { extends?: unknown }).extends]) {
      const target = declarationOf(declared, scope);
      if (target && target !== key) set.add(target);
    }
    if (node.manifest.kind !== "Telo.Import") {
      const imports = importsByScope.get(scope);
      if (imports) {
        for (const alias of referencedAliases(node.manifest)) {
          const target = imports.get(alias);
          if (target && target !== key) set.add(target);
        }
      }
    }
    unmet.set(key, set);
    for (const dep of set) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep)!.add(key);
    }
  }

  const queue = [...all.keys()].filter((key) => unmet.get(key)!.size === 0);
  const done = new Set<string>();
  const order: ResourceNode[] = [];
  while (order.length < all.size) {
    if (queue.length === 0) {
      // Only soft edges can hold the sort back here — the dependency edges are
      // acyclic — so release the first node whose dependencies are all met.
      for (const key of all.keys()) {
        if (done.has(key)) continue;
        if ([...(deps.get(key) ?? [])].every((d) => done.has(d) || !all.has(d))) {
          unmet.get(key)!.clear();
          queue.push(key);
          break;
        }
      }
    }
    const key = queue.shift()!;
    if (done.has(key)) continue;
    done.add(key);
    order.push(all.get(key)!);
    for (const dependent of dependents.get(key) ?? []) {
      const set = unmet.get(dependent)!;
      if (set.delete(key) && set.size === 0 && !done.has(dependent)) queue.push(dependent);
    }
  }
  return order;
}

/** Every import alias a reference inside `manifest` is written through — a
 *  resolved `{ kind, name, alias }` or a `!ref Alias.name` still tagged. */
function referencedAliases(manifest: ResourceManifest): Set<string> {
  const found = new Set<string>();
  const pending: unknown[] = [manifest];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const item of value) if (item !== null && typeof item === "object") pending.push(item);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const sentinel = refSentinelTarget(value);
    if (sentinel) {
      if (sentinel.alias && sentinel.alias !== "Self") found.add(sentinel.alias);
      continue;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) continue;
    const record = value as Record<string, unknown>;
    if (isResolvedReference(record) && record.alias !== undefined && record.alias !== "Self") {
      found.add(record.alias);
    }
    for (const child of Object.values(record)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return found;
}

const declaringModuleOf = (manifest: ResourceManifest): string | undefined =>
  (manifest.metadata as { module?: string } | undefined)?.module;

/** DFS cycle detection — returns the cycle path with the repeated start node
 *  appended, following only edges into `within` when given. */
function findCycle(
  keys: Iterable<string>,
  deps: Map<string, Set<string>>,
  within?: ReadonlySet<string>,
): string[] {
  type State = "unvisited" | "visiting" | "visited";
  const state = new Map<string, State>();
  for (const key of keys) state.set(key, "unvisited");

  const stack: string[] = [];

  function dfs(key: string): string[] | null {
    state.set(key, "visiting");
    stack.push(key);

    for (const dep of deps.get(key) ?? []) {
      if (within && !within.has(dep)) continue;
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

  for (const [key, s] of state) {
    if (s === "unvisited") {
      const result = dfs(key);
      if (result) return result;
    }
  }

  return [];
}

/**
 * Every strongly connected component that contains a loop (more than one node,
 * or one node depending on itself), each and all of them in node insertion
 * order. Tarjan's algorithm, iterative so a long dependency chain cannot
 * exhaust the call stack.
 */
function stronglyConnectedLoops(
  nodes: Map<string, ResourceNode>,
  deps: Map<string, Set<string>>,
): Array<Set<string>> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: Array<{ first: number; members: Set<string> }> = [];
  const position = new Map<string, number>();
  let i = 0;
  for (const key of nodes.keys()) position.set(key, i++);
  let counter = 0;

  for (const root of nodes.keys()) {
    if (index.has(root)) continue;
    const work: Array<{ key: string; next: Iterator<string> }> = [];
    const open = (key: string) => {
      index.set(key, counter);
      low.set(key, counter);
      counter++;
      stack.push(key);
      onStack.add(key);
      work.push({ key, next: (deps.get(key) ?? new Set<string>()).values() });
    };
    open(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const step = frame.next.next();
      if (!step.done) {
        const dep = step.value;
        if (!nodes.has(dep)) continue;
        if (!index.has(dep)) open(dep);
        else if (onStack.has(dep)) {
          low.set(frame.key, Math.min(low.get(frame.key)!, index.get(dep)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!));
      if (low.get(frame.key) !== index.get(frame.key)) continue;
      const members = new Set<string>();
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        members.add(member);
      } while (member !== frame.key);
      if (members.size > 1 || deps.get(frame.key)?.has(frame.key)) {
        const ordered = [...members].sort((a, b) => position.get(a)! - position.get(b)!);
        found.push({ first: position.get(ordered[0]!)!, members: new Set(ordered) });
      }
    }
  }

  return found.sort((a, b) => a.first - b.first).map((c) => c.members);
}

/** Every `Telo.Import` as a node, each keyed by the alias table it registers
 *  into and its alias — the two a reference through the alias is read with. */
type ImportNodes = ReadonlyMap<AliasResolver | undefined, ReadonlyMap<string, string>>;

/**
 * Every `Telo.Import` is a node of the boot order. An import is module wiring
 * rather than an instance the call graph knows, but it holds what it hands its
 * library and is what an export of that library exists after, so it orders
 * both ways: after the instances it is handed (below), and before every
 * resource referencing one of its exports ({@link addImportReferenceEdges}).
 */
function addImportNodes(
  resources: ResourceManifest[],
  nodes: Map<string, ResourceNode>,
  deps: Map<string, Set<string>>,
  aliases: AliasResolver | undefined,
  aliasesByModule: Map<string, AliasResolver> | undefined,
): ImportNodes {
  const out = new Map<AliasResolver | undefined, Map<string, string>>();
  for (const m of resources) {
    if (m.kind !== "Telo.Import") continue;
    const alias = m.metadata?.name as string | undefined;
    if (!alias) continue;
    const key = nodeIdFor(m);
    nodes.set(key, { kind: m.kind, name: alias, manifest: m });
    if (!deps.has(key)) deps.set(key, new Set<string>());
    const scope = moduleAliasScope(m.metadata, aliases, aliasesByModule);
    let byAlias = out.get(scope);
    if (!byAlias) out.set(scope, (byAlias = new Map()));
    byAlias.set(alias, key);
  }
  return out;
}

/** The import node `alias` names where `manifest` is declared. */
function importNodeOf(
  imports: ImportNodes,
  manifest: ResourceManifest,
  alias: string,
  aliases: AliasResolver | undefined,
  aliasesByModule: Map<string, AliasResolver> | undefined,
): string | undefined {
  return imports.get(moduleAliasScope(manifest.metadata, aliases, aliasesByModule))?.get(alias);
}

/**
 * Boot-order edges for what a `Telo.Import` holds: the instances it hands
 * DOWN to its target library's declared `resources:` inputs, and the needs and
 * fulfilments its `needs:` supplies read. A borrowed instance must exist before
 * the import initializes, and a cycle through one is a cycle like any other.
 * The edges are added here rather than read off the reference field map because
 * the accepted KIND at this slot is declared by the TARGET library, not by the
 * `Telo.Import` schema, so there is no `x-telo-ref` for the map to read; the
 * constraint itself is checked by `validate-resource-inputs`.
 */
function addResourceInputEdges(
  imports: ImportNodes,
  nodes: Map<string, ResourceNode>,
  deps: Map<string, Set<string>>,
): void {
  // An import node is named by its alias, which is also how a cross-module
  // reference names it, so one resolves like any other name.
  const names = new ScopedNameResolver(nodes, KEYED_NODE_READING);
  for (const byAlias of imports.values()) {
    for (const key of byAlias.values()) {
      const manifest = nodes.get(key)!.manifest;
      const targets = [
        ...Object.values(readSuppliedResources(manifest)).map(suppliedResourceTarget),
        ...needSupplyTargets(readSuppliedNeeds(manifest)),
      ].filter((name): name is string => name !== undefined);
      const set = deps.get(key)!;
      const fromModule = declaringModuleOf(manifest);
      for (const targetName of targets) {
        const target = names.resolve(targetName, fromModule)?.[0];
        if (target && target !== key) set.add(target);
      }
    }
  }
}

/**
 * A HARD edge from a resource to the import a reference at one of its own
 * reference slots is written through (`!ref Lib.table`): the referenced export
 * exists only once its import has initialized, and the slot is injected when
 * the resource is created. So a resource handed to an import that reaches an
 * export of that same import is a cycle, refused before anything initializes.
 * A step's reference is dispatched after boot and a kind spelled through an
 * alias names no instance, so neither is one.
 */
function addImportReferenceEdges(
  graph: CallGraph,
  nodes: Map<string, ResourceNode>,
  deps: Map<string, Set<string>>,
  imports: ImportNodes,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
): void {
  for (const edge of graph.edges) {
    if (edge.alias === undefined || !edge.injected || edge.nested || edge.scoped) continue;
    const from = nodes.get(edge.from);
    if (!from) continue;
    const target = importNodeOf(imports, from.manifest, edge.alias, aliases, aliasesByModule);
    if (target && target !== edge.from) deps.get(edge.from)!.add(target);
  }
}

/** What a resource input depends on. A CROSS-MODULE reference (`!ref Other.db`)
 *  names an instance exported by another import, never a local resource.
 *  Looking it up in the local name map would find an unrelated resource of the
 *  same name — a wrong edge, and possibly a phantom cycle — or nothing at all.
 *  What it depends on is the IMPORT that exports it, which is the projection
 *  `localDependencyNames` already makes at runtime. */
function suppliedResourceTarget(value: unknown): string | undefined {
  if (!isResolvedReference(value)) return undefined;
  return value.alias && value.alias !== "Self" ? value.alias : value.name;
}

/** What a `needs:` supply depends on: the need or fulfilment a whole supply
 *  names, and every resource a field-by-field supply reads — its expressions
 *  are evaluated when the import is created. */
function needSupplyTargets(supplied: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const value of Object.values(supplied)) {
    const supply = needSupplyOf(value);
    if (supply.form === "whole") {
      const { alias, name } = supply.target;
      out.push(alias && alias !== "Self" ? alias : name);
    } else if (supply.form === "fields") {
      out.push(...celResourceReads({ fields: supply.fields } as unknown as ResourceManifest));
    }
  }
  return out;
}

/**
 * Init-order edges for every observed-state read a resource makes in a field
 * that resolves at startup. A bare name resolves among the module's own
 * resources, same module first; a read through an import alias depends on that
 * import.
 */
function addStartupStatusReadEdges(
  nodes: Map<string, ResourceNode>,
  deps: Map<string, Set<string>>,
  registry: DefinitionRegistry,
  aliases: AliasResolver | undefined,
  aliasesByModule: Map<string, AliasResolver> | undefined,
  imports: ImportNodes,
): void {
  const names = new ScopedNameResolver(
    [...nodes].filter(([, node]) => node.kind !== "Telo.Import"),
    KEYED_NODE_READING,
  );
  const resolveDef: DefResolver = (kind, from) =>
    definitionInScope(registry, kind, from?.metadata, aliases, aliasesByModule);

  for (const [key, node] of nodes) {
    if (node.kind === "Telo.Import") continue;
    const sites = governedCelEvalSites(
      definitionInScope(registry, node.kind, node.manifest.metadata, aliases, aliasesByModule),
      resolveDef,
      registry.shapeLookup,
    );
    if (!sites) continue;
    const fromModule = declaringModuleOf(node.manifest);
    for (const read of startupObservedStateReads(node.manifest, sites)) {
      if (read.alias !== undefined) {
        const importKey = importNodeOf(imports, node.manifest, read.alias, aliases, aliasesByModule);
        if (importKey !== undefined && importKey !== key) deps.get(key)!.add(importKey);
        continue;
      }
      // A startup read sits in a compile-eval field, where the `resources`
      // record holds no scope member: the name is a module-level one.
      const target = names.resolve(read.name, fromModule);
      if (target) deps.get(key)!.add(target[0]);
    }
  }
}

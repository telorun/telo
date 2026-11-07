import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { buildCallGraph, type CallGraphEdge, type ResourceGraphNode } from "./call-graph.js";
import { canonicalKindOf, kindIsA } from "./co-referrer-slot.js";
import { registeredCoReferrerCalls } from "./co-referrers.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { readModuleGlobals } from "./flatten-for-analyzer.js";
import { isKindDocumentOrImport } from "./system-kinds.js";
import { definitionInScope } from "./module-alias-scope.js";
import type { ModuleDocuments } from "./module-documents.js";
import { instancesOf, moduleInstanceTreeOfSet } from "./module-instance-tree.js";
import { isModuleKind } from "./module-kinds.js";
import { normalizeInlineResources } from "./normalize-inline-resources.js";
import { importReach } from "./reaching-import.js";
import type { CoReferrerCall } from "./ref-slot.js";
import { pointerToPath } from "./resource-rule.js";
import { importPathOf } from "./scoped-name-resolver.js";

/**
 * What an importer's analysis holds of each imported library for the
 * `callsCoReferrers` fan-out: the analysis is closed-world at the assembly
 * root, so every co-referrer and every caller of one must be in view there.
 *
 * Per library, three classes of module-scope declaration, each forwarded as the
 * library's code (`forwardedInternal`, never reported as the entry's own):
 *  - every **co-referrer** under a registered `callsCoReferrers` call — a
 *    declaration of the call's kind, or a kind extending it, holding a
 *    reference at its slot;
 *  - every **holder** of a `callsCoReferrers` slot, inline ones included (their
 *    module-scope declaration is forwarded);
 *  - every declaration on a **call path** from one of the library's entry
 *    points — its exported instances and its co-referrers — to a holder;
 *
 * plus the declaration each holder's and co-referrer's slot names, the identity
 * the fan-out matches on. A library with more than one instance in the import
 * tree gets one copy per instance, stamped with its `importPath`. What the set already forwards (an
 * export) is not forwarded again.
 *
 * Browser-safe.
 */

export interface StandInScope {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
}

/** One library's reading: its co-referrers' names and what is forwarded of it,
 *  in document order. */
export interface LibraryCoReferrerReading {
  readonly coReferrers: ReadonlySet<string>;
  readonly forwarded: readonly ResourceManifest[];
}

const readings = new WeakMap<ModuleDocuments, { generation: number; reading: LibraryCoReferrerReading }>();

const EMPTY: LibraryCoReferrerReading = { coReferrers: new Set(), forwarded: [] };

/** Every `callsCoReferrers` the registered kinds declare. */
export function registryCoReferrerCalls(defs: DefinitionRegistry): CoReferrerCall[] {
  const resolve = (kind: string) => defs.resolve(kind);
  return registeredCoReferrerCalls(
    defs.kinds().flatMap((kind) => defs.resolve(kind) ?? []),
    resolve,
  );
}

/** The co-referrers and forwarded declarations of one library, memoized per
 *  document set and registry generation. */
export function libraryCoReferrerReading(docs: ModuleDocuments, scope: StandInScope): LibraryCoReferrerReading {
  const known = readings.get(docs);
  if (known && known.generation === scope.defs.generation) return known.reading;
  const reading = readLibrary(docs, scope);
  readings.set(docs, { generation: scope.defs.generation, reading });
  return reading;
}

function readLibrary(docs: ModuleDocuments, scope: StandInScope): LibraryCoReferrerReading {
  const calls = registryCoReferrerCalls(scope.defs);
  if (calls.length === 0) return EMPTY;
  const { defs, aliases, aliasesByModule } = scope;
  const resolve = (kind: string): ResourceDefinition | undefined => defs.resolve(kind);
  const topLevel = new Map<string, ResourceManifest>();
  for (const m of docs.manifests) {
    const name = m.metadata?.name;
    if (typeof name !== "string" || isModuleKind(m.kind) || isKindDocumentOrImport(m)) continue;
    if (!topLevel.has(name)) topLevel.set(name, m);
  }
  if (topLevel.size === 0) return EMPTY;

  const normalized = normalizeInlineResources(docs.manifests, defs, aliases, aliasesByModule);
  const graph = buildCallGraph(normalized, defs, { aliases, aliasesByModule, coReferrers: false });

  // The module-scope declaration a node belongs to: itself, the declaration an
  // inline one was extracted from, or the holder of the scope it is a member of.
  const rootOf = (node: ResourceGraphNode): string | undefined => {
    let current: ResourceGraphNode | undefined = node;
    for (let depth = 0; current && depth < 64; depth++) {
      if (current.scoped && current.scopeOwner) {
        const owner = graph.nodes.get(current.scopeOwner);
        current = owner?.type === "resource" ? owner : undefined;
        continue;
      }
      const origin = (current.manifest.metadata as { xTeloOrigin?: { parentName?: unknown } } | undefined)
        ?.xTeloOrigin;
      if (typeof origin?.parentName !== "string") return topLevel.has(current.name) ? current.name : undefined;
      current = graph.resourceByName(origin.parentName, docs.module) as ResourceGraphNode | undefined;
    }
    return undefined;
  };
  const resourceOf = (id: string): ResourceGraphNode | undefined => {
    const node = graph.nodes.get(id);
    if (node?.type === "resource") return node;
    if (node?.type === "step") {
      const owner = graph.nodes.get(node.owner);
      return owner?.type === "resource" ? owner : undefined;
    }
    return undefined;
  };

  const coReferrers = new Set<string>();
  const holders = new Set<string>();
  /** What a holder's or a co-referrer's slot names: the identity the fan-out
   *  matches on, which must be in view as well. */
  const targets = new Set<string>();
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const from = resourceOf(edge.from);
    if (!from) continue;
    if (edge.callsCoReferrers) {
      holders.add(from.id);
      if (edge.to) targets.add(edge.to);
    }
    if (!edge.to || !transfersControl(edge)) continue;
    const to = resourceOf(edge.to);
    if (!to) continue;
    (forward.get(from.id) ?? forward.set(from.id, []).get(from.id)!).push(to.id);
    (backward.get(to.id) ?? backward.set(to.id, []).get(to.id)!).push(from.id);
  }
  for (const node of graph.nodes.values()) {
    if (node.type !== "resource" || node.scoped || !topLevel.has(node.name)) continue;
    if ((node.manifest.metadata as { xTeloOrigin?: unknown } | undefined)?.xTeloOrigin) continue;
    const definition = definitionInScope(defs, node.kind, node.manifest.metadata, aliases, aliasesByModule);
    if (!definition) continue;
    const kind = canonicalKindOf(definition);
    const written = graph.edgesFrom(node.id).filter((e) => !e.nested && !e.moduleCall);
    for (const call of calls) {
      const slot = pointerToPath(call.slot);
      const at = written.filter((e) => e.path === slot);
      if (at.length === 0 || !kindIsA(kind, call.kind, resolve)) continue;
      coReferrers.add(node.name);
      for (const edge of at) if (edge.to) targets.add(edge.to);
    }
  }

  const reach = (starts: Iterable<string>, adjacency: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>(starts);
    const queue = [...seen];
    while (queue.length > 0) {
      for (const next of adjacency.get(queue.shift()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  };
  const idsOf = (names: Iterable<string>): string[] => {
    const out: string[] = [];
    for (const name of names) {
      const node = graph.resourceByName(name, docs.module);
      if (node) out.push(node.id);
    }
    return out;
  };
  const holderIds = [...holders];
  const fromEntries = reach(idsOf([...docs.exportedNames, ...coReferrers]), forward);
  const toHolders = reach(holderIds, backward);

  const selected = new Set<string>(coReferrers);
  for (const id of holderIds) {
    const node = graph.nodes.get(id);
    const root = node?.type === "resource" ? rootOf(node) : undefined;
    if (root) selected.add(root);
  }
  for (const id of targets) {
    const node = graph.nodes.get(id);
    const root = node?.type === "resource" ? rootOf(node) : undefined;
    if (root) selected.add(root);
  }
  for (const id of fromEntries) {
    if (!toHolders.has(id)) continue;
    const node = graph.nodes.get(id);
    const root = node?.type === "resource" ? rootOf(node) : undefined;
    if (root) selected.add(root);
  }
  return {
    coReferrers,
    forwarded: [...topLevel.values()].filter((m) => selected.has(m.metadata!.name as string)),
  };
}

/** Whether control can reach the target through the edge. */
function transfersControl(edge: CallGraphEdge): boolean {
  if (edge.moduleCall || edge.coReferrer) return false;
  return edge.use.length === 0 || edge.use.some((use) => use !== "dependency" && use !== "schema");
}

/**
 * The stand-ins `set` gains: each imported library's forwarded declarations
 * (`libraryCoReferrerReading`), once per instance of the library the set's
 * import tree reaches.
 */
export function coReferrerStandIns(
  set: readonly ResourceManifest[],
  libraries: readonly ModuleDocuments[],
  scope: StandInScope,
): ResourceManifest[] {
  if (libraries.length === 0) return [];
  const { tree, rootModules } = moduleInstanceTreeOfSet(set);
  const instancePaths = new Map<string, (readonly string[])[]>();
  for (const instance of instancesOf(tree)) {
    if (instance.importer === undefined) continue;
    const list = instancePaths.get(instance.module);
    if (list) list.push(instance.path);
    else instancePaths.set(instance.module, [instance.path]);
  }
  const present = new Map<string, Set<string>>();
  for (const m of set) {
    const module = (m.metadata as { module?: unknown } | undefined)?.module;
    const name = m.metadata?.name;
    if (typeof module !== "string" || typeof name !== "string") continue;
    const key = `${module}\0${name}`;
    const paths = present.get(key) ?? present.set(key, new Set()).get(key)!;
    paths.add(importPathOf(m)?.join("/") ?? "");
  }
  const loads = importReach(set, rootModules);
  const seen = new Set<string>();
  const out: ResourceManifest[] = [];
  for (const docs of libraries) {
    const paths = instancePaths.get(docs.module);
    if (!paths || seen.has(docs.module) || !loads.loads(docs)) continue;
    seen.add(docs.module);
    const { forwarded } = libraryCoReferrerReading(docs, scope);
    if (forwarded.length === 0) continue;
    const moduleGlobals = readModuleGlobals(docs.manifests.find((m) => isModuleKind(m.kind)));
    const several = paths.length > 1;
    for (const path of several ? paths : [undefined]) {
      for (const m of forwarded) {
        const already = present.get(`${docs.module}\0${m.metadata!.name as string}`);
        if (already && (several ? already.has(path!.join("/")) : already.size > 0)) continue;
        out.push({
          ...m,
          metadata: {
            ...m.metadata,
            forwardedInternal: true,
            ...(moduleGlobals ? { moduleGlobals } : {}),
            ...(path ? { importPath: [...path] } : {}),
          } as ResourceManifest["metadata"],
        });
      }
    }
  }
  return out;
}

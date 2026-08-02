import {
  parseExportEntry,
  resolveExportedKinds,
  type LoadedGraph,
  type LoadedModule,
} from "@telorun/analyzer";
import type { DefinitionResult } from "../types.js";
import {
  locateKindDefinition,
  locateResource,
  moduleDoc,
  moduleFiles,
  moduleName,
} from "./manifest-navigation.js";

/** One `exports.*` list as authored. `undefined` means the block is ABSENT,
 *  which is not the same as an empty list — the distinction is the gate itself,
 *  and it is load-bearing in both halves (`AliasResolver.registerImport`,
 *  `ModuleContext.buildExportTable`), so it must survive here too. */
function exportList(
  mod: LoadedModule,
  block: "kinds" | "resources",
): readonly string[] | undefined {
  const exports = (moduleDoc(mod) as { exports?: Record<string, unknown> } | undefined)?.exports;
  const list = exports?.[block];
  if (!Array.isArray(list)) return undefined;
  return list.filter((e): e is string => typeof e === "string");
}

/** Every loaded module keyed by its `metadata.name` — what `resolveExportedKinds`
 *  speaks, since a canonical kind names its owning module rather than a URL. */
function modulesByName(graph: LoadedGraph): Map<string, LoadedModule> {
  const byName = new Map<string, LoadedModule>();
  for (const mod of graph.modules.values()) {
    const name = moduleName(mod);
    if (name && !byName.has(name)) byName.set(name, mod);
  }
  return byName;
}

/** Resolve the kind suffix `name` exported by the module at `targetSource` to
 *  the `Telo.Definition` / `Telo.Abstract` doc that owns it.
 *
 *  The gate and the transitive re-export chain come from the analyzer's own
 *  `resolveExportedKinds` fixpoint rather than a local walk, so navigation
 *  cannot disagree with `telo check` about what an import exposes — including
 *  the two rules a hand-rolled walk gets wrong: `exports.kinds: []` gates
 *  everything while an absent block gates nothing, and a re-export FROM an
 *  ungated module resolves straight to it. */
export function resolveExportedKind(
  graph: LoadedGraph,
  targetSource: string,
  name: string,
): DefinitionResult | undefined {
  const target = graph.modules.get(targetSource);
  if (!target) return undefined;

  // No `exports.kinds` block → every kind the module defines is importable (the
  // legacy permissive default the kernel still honors for already-published
  // versions). The fixpoint builds tables only from declared entries, so an
  // ungated module has none to look this up in — and this is also the cheap
  // path, so it settles before anything is indexed.
  if (exportList(target, "kinds") === undefined) {
    return locateKindDefinition(moduleFiles(target), name);
  }

  const targetName = moduleName(target);
  if (!targetName) return undefined;

  const byName = modulesByName(graph);
  const tables = resolveExportedKinds(
    [...byName].map(([module, mod]) => ({ module, exportsKinds: exportList(mod, "kinds") })),
    (module, alias) => {
      const owner = byName.get(module)?.owner.source;
      return owner ? graph.importEdges.get(owner)?.get(alias)?.targetModuleName ?? undefined : undefined;
    },
  );

  const canonical = tables.get(targetName)?.get(name);
  if (!canonical) return undefined;

  // `<owningModule>.<Kind>` — a re-export resolves to its true owner, so the
  // jump lands where the kind is actually declared, however many hops away.
  const dot = canonical.lastIndexOf(".");
  const owner = byName.get(canonical.slice(0, dot));
  return owner ? locateKindDefinition(moduleFiles(owner), canonical.slice(dot + 1)) : undefined;
}

/** Resolve the instance `name` exported by the module at `targetSource`,
 *  following `<Alias>.<name>` re-exports transitively. `seen` bounds cyclic
 *  import graphs.
 *
 *  Unlike kinds there is no permissive default: the kernel reads
 *  `exports.resources ?? []` and builds its export table strictly from that, so
 *  an absent block exports nothing and an unlisted name is an
 *  `UNRESOLVED_REFERENCE` — navigating to it would tell the author a wiring is
 *  real that the analyzer rejects. */
export function resolveExportedResource(
  graph: LoadedGraph,
  targetSource: string,
  name: string,
  seen: Set<string> = new Set(),
): DefinitionResult | undefined {
  if (seen.has(targetSource)) return undefined;
  seen.add(targetSource);
  const target = graph.modules.get(targetSource);
  if (!target) return undefined;

  const entries = (exportList(target, "resources") ?? []).map(parseExportEntry);
  const entry = entries.find((e) => e.name === name);
  if (!entry) return undefined;

  // `Self.<name>` names the declaring module's own instance, exactly as a bare
  // name does — `ModuleContext.buildExportTable` treats the two alike.
  if (!entry.alias || entry.alias === "Self") return locateResource(moduleFiles(target), name);

  const edge = graph.importEdges.get(target.owner.source)?.get(entry.alias);
  return edge ? resolveExportedResource(graph, edge.targetSource, name, seen) : undefined;
}

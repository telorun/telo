import type { ResourceManifest } from "@telorun/sdk";
import { isKindDocument } from "./kind-declaration.js";
import type { LoadedGraph, LoadedModule } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";

/**
 * A written kind resolved over a LOADED graph, before any registry exists: the
 * prefix through the declaring module's own import edges (`Self` and the
 * module's own name naming the module itself), the name to the kind document
 * the target declares — or, for a library re-exporting it
 * (`exports.kinds: [<Alias>.<Kind>]`), the one its own import reaches. A
 * built-in `Telo.<Kind>` is in no loaded module and resolves to nothing here.
 *
 * Browser-safe.
 */

export type LoadedKindScope = Pick<LoadedGraph, "modules" | "importEdges">;

/** Every file of a module, owner first. */
export const filesOf = (mod: LoadedModule) => [mod.owner, ...mod.partials];

export function moduleNameOf(mod: LoadedModule): string | undefined {
  const doc = mod.owner.manifests.find((m) => m && isModuleKind(m.kind));
  const name = doc?.metadata?.name;
  return typeof name === "string" ? name : undefined;
}

/** The import aliased `alias` in one of `mod`'s files, as the graph resolved it. */
export function importTarget(graph: LoadedKindScope, mod: LoadedModule, alias: string): LoadedModule | undefined {
  for (const file of filesOf(mod)) {
    const edge = graph.importEdges.get(file.source)?.get(alias);
    if (edge) return graph.modules.get(edge.targetSource);
  }
  return undefined;
}

function kindDocumentNamed(mod: LoadedModule, name: string): ResourceManifest | undefined {
  for (const file of filesOf(mod)) {
    const doc = file.manifests.find((m) => m && isKindDocument(m) && m.metadata?.name === name);
    if (doc) return doc;
  }
  return undefined;
}

/** The kind document `kind`, written in `mod`, names — with the module declaring it. */
export function kindDocumentIn(
  graph: LoadedKindScope,
  mod: LoadedModule,
  kind: string,
  seen: Set<string> = new Set(),
): { module: LoadedModule; moduleName: string; doc: ResourceManifest } | undefined {
  const dot = kind.indexOf(".");
  if (dot <= 0) return undefined;
  const prefix = kind.slice(0, dot);
  const name = kind.slice(dot + 1);
  const own = prefix === "Self" || prefix === moduleNameOf(mod);
  const target = own ? mod : importTarget(graph, mod, prefix);
  const targetName = target ? moduleNameOf(target) : undefined;
  if (!target || !targetName) return undefined;
  const key = `${target.owner.source}\0${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const doc = kindDocumentNamed(target, name);
  if (doc) return { module: target, moduleName: targetName, doc };
  if (own) return undefined;
  const library = target.owner.manifests.find((m) => m && isModuleKind(m.kind)) as
    | { exports?: { kinds?: unknown } }
    | undefined;
  const exported = Array.isArray(library?.exports?.kinds) ? library.exports.kinds : [];
  for (const entry of exported) {
    if (typeof entry !== "string") continue;
    const at = entry.indexOf(".");
    if (at <= 0 || entry.slice(at + 1) !== name) continue;
    return kindDocumentIn(graph, target, entry, seen);
  }
  return undefined;
}

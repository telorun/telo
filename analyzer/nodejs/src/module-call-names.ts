/**
 * **The names a module's CEL calls resolve through.**
 *
 * A call whose receiver is one of them is a call on a resource of the module
 * that name reaches (`Billing.format(x)`), not a method on a value; everything
 * else is the core catalog. The set is a module's own `imports:` keys, `Self`,
 * its `metadata.name` and `Telo`.
 *
 * Two derivations, one rule. They are asked at opposite ends of loading and
 * cannot share an input:
 *
 *  - {@link moduleCallNamesOfFile} runs at PARSE, where the only thing in hand
 *    is one file's documents — before any import resolves, which is exactly why
 *    the rule is written over declared names rather than resolved targets. A
 *    partial declares no module doc of its own and compiles with the names of
 *    the module that includes it, so the caller passes those in.
 *  - {@link moduleCallNamesByModule} runs over a FLATTENED analysis set, where a
 *    library's own module doc has been dropped and its imports arrive as
 *    `Telo.Import` documents stamped with the module that declared them.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isModuleKind } from "./module-kinds.js";

/** The built-in namespace, ungated and available with no `imports:` entry. */
export const TELO_MODULE_NAME = "Telo";

/** The alias a module always has for itself. */
export const SELF_ALIAS = "Self";

/** The names every module has, whatever it declares. */
function baseNames(moduleName?: string): Set<string> {
  const names = new Set<string>([SELF_ALIAS, TELO_MODULE_NAME]);
  if (moduleName) names.add(moduleName);
  return names;
}

/** The `imports:` keys a module doc declares, in the inline map form the loader
 *  desugars later. Read here rather than after desugaring because compilation
 *  happens first: `precompileDoc` runs inside `parseLoadedFile`, before
 *  `desugarLoadedFile`. */
function inlineImportAliases(moduleDoc: Record<string, unknown> | undefined): string[] {
  const imports = moduleDoc?.imports;
  return imports !== null && typeof imports === "object" && !Array.isArray(imports)
    ? Object.keys(imports as Record<string, unknown>)
    : [];
}

/**
 * The names for the documents of ONE file.
 *
 * `inherited` is the including module's set, for a partial: a partial carries no
 * module doc, and its expressions belong to the module that included it.
 */
export function moduleCallNamesOfFile(
  manifests: ReadonlyArray<ResourceManifest | null>,
  inherited?: ReadonlySet<string>,
): ReadonlySet<string> {
  const moduleDoc = manifests.find((m) => m && isModuleKind(m.kind)) as
    | Record<string, any>
    | undefined;
  if (!moduleDoc) return inherited ?? baseNames();

  const names = baseNames(
    typeof moduleDoc.metadata?.name === "string" ? moduleDoc.metadata.name : undefined,
  );
  for (const alias of inlineImportAliases(moduleDoc)) names.add(alias);
  // An authored `Telo.Import` document is the other spelling of the same map,
  // and a file may carry both.
  for (const m of manifests) {
    const alias = m?.kind === "Telo.Import" ? m.metadata?.name : undefined;
    if (typeof alias === "string" && alias) names.add(alias);
  }
  return names;
}

/**
 * The module a manifest's OWN NAMES are written in, in the key shape this
 * table uses.
 *
 * `metadata.module` is not that module for every manifest: a re-exported
 * instance is emitted once per re-exporting module with `module` overwritten
 * (`forwardReExportManifests`), so a library's expression would be read in the
 * scope of a module that merely passes it on — reporting the aliases of one
 * author's file against another's. `metadata.moduleGlobals.module` is the
 * DECLARING module doc's own metadata and travels with the manifest unchanged,
 * so it answers where the text was written; `metadata.module` is the fallback
 * for everything that never crossed a boundary.
 *
 * The same rule `buildKernelGlobalsIndex` and the `module.<field>` scope follow,
 * and for the same reason: a forwarded manifest's globals are its library's.
 */
export function declaringModuleKey(manifest: ResourceManifest | undefined): string {
  const meta = manifest?.metadata as
    | { module?: unknown; moduleGlobals?: { module?: { name?: unknown } } }
    | undefined;
  const declared = meta?.moduleGlobals?.module?.name;
  if (typeof declared === "string" && declared) return declared;
  const stamped = meta?.module;
  return typeof stamped === "string" && stamped ? stamped : ROOT_MODULE_KEY;
}

/**
 * The names per DECLARING module, over a flattened analysis set.
 *
 * Keyed by module name, with the entry-owned modules (whose manifests carry no
 * `metadata.module` stamp) also reachable under {@link ROOT_MODULE_KEY} — the
 * set a manifest with no stamp is read in.
 */
export function moduleCallNamesByModule(
  manifests: readonly ResourceManifest[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const byModule = new Map<string, Set<string>>();
  const rootModules = new Set<string>();
  const namesFor = (module: string): Set<string> => {
    let names = byModule.get(module);
    if (!names) byModule.set(module, (names = baseNames(module)));
    return names;
  };

  for (const m of manifests) {
    if (!isModuleKind(m.kind)) continue;
    const name = m.metadata?.name;
    if (typeof name !== "string" || !name) continue;
    rootModules.add(name);
    const names = namesFor(name);
    for (const alias of inlineImportAliases(m as Record<string, unknown>)) names.add(alias);
  }

  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const alias = m.metadata?.name;
    if (typeof alias !== "string" || !alias) continue;
    namesFor(declaringModuleKey(m)).add(alias);
  }

  // Every module that declares anything at all gets an entry, so a lookup for a
  // library whose only contribution is a definition still knows `Self` and the
  // library's own name.
  for (const m of manifests) {
    const owner = declaringModuleKey(m);
    if (owner !== ROOT_MODULE_KEY) namesFor(owner);
  }

  // The entry's own modules share one scope: their imports go into the same
  // table the analyzer's root `AliasResolver` holds, so a manifest with no
  // module stamp resolves through all of them.
  const root = namesFor(ROOT_MODULE_KEY);
  for (const name of rootModules) for (const alias of namesFor(name)) root.add(alias);
  for (const name of rootModules) for (const alias of root) namesFor(name).add(alias);

  return byModule;
}

/** Lookup key for a manifest the entry itself owns — one that carries no
 *  `metadata.module` stamp. */
export const ROOT_MODULE_KEY = "";

/** The names in force for one manifest, given the per-module table. */
export function moduleCallNamesOf(
  byModule: ReadonlyMap<string, ReadonlySet<string>>,
  manifest: ResourceManifest | undefined,
): ReadonlySet<string> {
  return (
    byModule.get(declaringModuleKey(manifest)) ?? byModule.get(ROOT_MODULE_KEY) ?? baseNames()
  );
}

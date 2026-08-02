import type { LoadedGraph, LoadedModule } from "@telorun/analyzer";
import type { DefinitionResult } from "../types.js";
import type { AliasQualifiedValue } from "./alias-qualified-value.js";
import { locateImport, locateResource, moduleFiles } from "./manifest-navigation.js";
import { resolveExportedResource } from "./resolve-export-chain.js";

/** Resolve a `!ref` target to the resource instance it names.
 *
 *  The grammar mirrors `resolveRefSentinels`: a bare name (or `Self.name`) is a
 *  local resource in the current module; `Alias.name` is an exported instance of
 *  the module the import `Alias` points at, followed transitively through
 *  re-exports and gated on each module's `exports.resources`. The alias half
 *  navigates to the import that declares it. Returns `undefined` when the target
 *  can't be found (a scope-local name, an instance the target does not export,
 *  or an import that failed to load). */
export function resolveRefTarget(
  graph: LoadedGraph,
  currentModule: LoadedModule,
  ref: AliasQualifiedValue,
): DefinitionResult | undefined {
  const { alias, name, onAlias } = ref;

  if (alias === undefined || alias === "Self") {
    // `Self` names the declaring module itself — there is no import to jump to,
    // so the alias half resolves like the name half.
    return locateResource(moduleFiles(currentModule), name);
  }

  if (onAlias) return locateImport(currentModule, alias);

  const edge = graph.importEdges.get(currentModule.owner.source)?.get(alias);
  if (!edge) return undefined;
  return resolveExportedResource(graph, edge.targetSource, name);
}

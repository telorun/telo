import type { LoadedGraph, LoadedModule } from "@telorun/analyzer";
import type { DefinitionResult } from "../types.js";
import type { ResolvedCursor } from "../completions/resolve-node.js";
import type { AliasQualifiedValue } from "./alias-qualified-value.js";
import { locateImport, locateKindDefinition, moduleFiles } from "./manifest-navigation.js";
import { resolveExportedKind } from "./resolve-export-chain.js";

const DEFINITION_DOC_KINDS = new Set(["Telo.Definition", "Telo.Abstract"]);

/** Whether the cursor sits in a slot whose value is an alias-qualified kind.
 *
 *  `x-telo-ref` is an `x-telo-*` annotation, unambiguous wherever it appears.
 *  `extends:` is only a kind at the top level of a definition doc, so it is
 *  gated on both. `kind:` is positional by nature: a map carrying a
 *  `<Alias>.<Kind>` value under `kind` IS an inline resource declaration as far
 *  as the analyzer is concerned too (`resourceKindOf`), so there is no further
 *  structure to check — an unresolvable value simply navigates nowhere.
 *
 *  `capability:` is deliberately absent — its values are kernel built-ins with
 *  no manifest to jump to (hover documents them instead). */
export function isKindSlot(resolved: ResolvedCursor): boolean {
  const key = resolved.path[resolved.path.length - 1];
  if (key === "x-telo-ref" || key === "kind") return true;
  return (
    key === "extends" &&
    resolved.path.length === 1 &&
    DEFINITION_DOC_KINDS.has(resolved.docKind ?? "")
  );
}

/** Resolve an alias-qualified kind (`Http.Server`) to the `Telo.Definition` /
 *  `Telo.Abstract` doc that registers it, or — when the cursor sits on the
 *  alias — to the import that declares the alias.
 *
 *  `Self.<Kind>` is the declaring module's own kind; `Telo.<Kind>` is a kernel
 *  built-in with no manifest, so it resolves to nothing. Across an import the
 *  walk honors `exports.kinds` and follows `<Inner>.<Kind>` re-exports to the
 *  owning module, matching what the kernel resolves the kind to at runtime. */
export function resolveKindTarget(
  graph: LoadedGraph,
  currentModule: LoadedModule,
  kind: AliasQualifiedValue,
): DefinitionResult | undefined {
  const { alias, name, onAlias } = kind;

  if (alias === undefined) {
    // The legacy `<namespace>/<module>#<Kind>` identity form of `x-telo-ref`
    // still resolves for already-published module versions, but it names a
    // module this manifest need not import, so there is no alias to follow.
    if (name.includes("#")) return undefined;
    return locateKindDefinition(moduleFiles(currentModule), name);
  }
  if (alias === "Self") return locateKindDefinition(moduleFiles(currentModule), name);
  if (alias === "Telo") return undefined;

  if (onAlias) return locateImport(currentModule, alias);

  const edge = graph.importEdges.get(currentModule.owner.source)?.get(alias);
  if (!edge) return undefined;
  return resolveExportedKind(graph, edge.targetSource, name);
}

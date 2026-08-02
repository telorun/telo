import { parseToAst, type AstDocument, type AstScalar, type LoadedGraph } from "@telorun/analyzer";
import type { DefinitionResult } from "../types.js";
import { resolveNodeAtPosition } from "../completions/resolve-node.js";
import { splitAliasQualified } from "./alias-qualified-value.js";
import { moduleForFile } from "./manifest-navigation.js";
import { resolveCelTarget } from "./resolve-cel-target.js";
import { isKindSlot, resolveKindTarget } from "./resolve-kind-target.js";
import { resolveRefTarget } from "./resolve-ref-target.js";

/** Resolve the symbol under the cursor to where it is declared.
 *
 *  Three navigable symbol classes, each dispatched on what the cursor sits in
 *  rather than on the field it happens to be under:
 *
 *  - a CEL identifier (`variables.port`, `resources.Store.conn`) → its
 *    declaration on the module doc, or the resource it names;
 *  - an alias-qualified kind (`kind: Http.Server`, `extends:`, `x-telo-ref`) →
 *    the `Telo.Definition` that registers it;
 *  - a `!ref` target → the resource instance it names.
 *
 *  In the last two the alias half (`Http`) navigates to the import that declares
 *  it, and the suffix to what the alias qualifies. Returns `undefined` when the
 *  cursor is on nothing navigable, or the target can't be found (a kernel
 *  built-in, a scope-local name, an unexported entry, or an import that failed
 *  to load). */
export function buildDefinition(
  text: string,
  line: number,
  character: number,
  graph: LoadedGraph,
  currentFilePath: string,
  docs?: AstDocument[],
): DefinitionResult | undefined {
  const astDocs = docs ?? parseToAst(text);
  const resolved = resolveNodeAtPosition(text, astDocs, line, character);
  if (!resolved) return undefined;

  const currentModule = moduleForFile(graph, currentFilePath) ?? graph.entry;

  if (resolved.cel) {
    return resolveCelTarget(graph, currentModule, resolved.cel.segment, resolved.cel.offset);
  }

  const node = resolved.node;
  if (resolved.slot !== "value" || node?.kind !== "scalar") return undefined;

  const split = splitAliasQualified(text, node as AstScalar, resolved.offset);
  if (!split) return undefined;

  if (node.tag === "!ref") return resolveRefTarget(graph, currentModule, split);
  if (isKindSlot(resolved)) return resolveKindTarget(graph, currentModule, split);
  return undefined;
}

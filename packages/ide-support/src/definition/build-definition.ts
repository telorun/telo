import {
  parseToAst,
  type AstDocument,
  type AstScalar,
  type ManifestAnalysis,
  type LoadedGraph,
} from "@telorun/analyzer";
import type { DefinitionResult } from "../types.js";
import { resolveNodeAtPosition } from "../completions/resolve-node.js";
import { splitAliasQualified } from "./alias-qualified-value.js";
import { locateContextBinding } from "./locate-context-binding.js";
import { locateStepDeclaration } from "./locate-step.js";
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
  /** Lets a `steps.<name>` read navigate to the step that produced it, and a
   *  context binding to its declaration — both need the declaring kind's own
   *  annotations, which only the analysis can read. */
  analysis?: ManifestAnalysis,
): DefinitionResult | undefined {
  const astDocs = docs ?? parseToAst(text);
  const resolved = resolveNodeAtPosition(text, astDocs, line, character);
  if (!resolved) return undefined;

  const currentModule = moduleForFile(graph, currentFilePath) ?? graph.entry;

  if (resolved.cel) {
    return resolveCelTarget(graph, currentModule, resolved.cel.segment, resolved.cel.offset, {
      // A step is resolved in the CURRENT document — `steps.<name>.result` is
      // readable only inside the resource that declares it, which is one
      // document. Supplied as a closure so the chain resolver stays free of the
      // AST and the scope query alike.
      locateStep: (stepName) =>
        locateStepDeclaration(graph, currentFilePath, astDocs, resolved.docIndex, stepName, analysis?.celScope),
      locateContextBinding: (parts) =>
        locateContextBinding(
          graph,
          astDocs,
          resolved.docIndex,
          resolved.concretePath ?? "",
          parts,
          analysis?.celScope,
        ),
    });
  }

  const node = resolved.node;
  if (resolved.slot !== "value" || node?.kind !== "scalar") return undefined;

  const split = splitAliasQualified(text, node as AstScalar, resolved.offset);
  if (!split) return undefined;

  if (node.tag === "!ref") return resolveRefTarget(graph, currentModule, split);
  if (isKindSlot(resolved)) return resolveKindTarget(graph, currentModule, split);
  return undefined;
}

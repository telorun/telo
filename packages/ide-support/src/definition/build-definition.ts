import {
  CelParseError,
  buildLineOffsets,
  offsetToPosition,
  parseToAst,
  type AstDocument,
  type AstScalar,
  type CelNode,
  type ManifestAnalysis,
  type LoadedGraph,
  type LoadedModule,
} from "@telorun/analyzer";
import type { DefinitionResult } from "../types.js";
import { moduleCallAt } from "../cel/module-calls.js";
import { resolveNodeAtPosition } from "../completions/resolve-node.js";
import { docIdentity } from "../doc-identity.js";
import { splitAliasQualified } from "./alias-qualified-value.js";
import { locateContextBinding } from "./locate-context-binding.js";
import { locateStepDeclaration } from "./locate-step.js";
import { locateImport, moduleForFile } from "./manifest-navigation.js";
import { resolveCelTarget } from "./resolve-cel-target.js";
import { isKindSlot, resolveKindTarget } from "./resolve-kind-target.js";
import { resolveRefTarget } from "./resolve-ref-target.js";
import { forEachLoops, loopBinding, readRefScalar } from "../repeats/for-each.js";

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
    const call = moduleCallTarget(graph, currentModule, text, astDocs, resolved, analysis);
    if (call !== NOT_A_MODULE_CALL) return call;
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

  if (node.tag === "!ref") {
    return refTarget(text, node as AstScalar, resolved.offset, astDocs[resolved.docIndex]!, graph, currentModule, currentFilePath);
  }

  const split = splitAliasQualified(text, node as AstScalar, resolved.offset);
  if (!split) return undefined;

  if (isKindSlot(resolved)) return resolveKindTarget(graph, currentModule, split);
  return undefined;
}

/** A `!ref` under the cursor, read as the engine's verdict: an index's binding
 *  goes to the loop declaring it (its `as:`, else its tag), a family's head to
 *  the family's tag, anything else as the name or alias it holds. */
function refTarget(
  text: string,
  scalar: AstScalar,
  offset: number,
  doc: AstDocument,
  graph: LoadedGraph,
  currentModule: LoadedModule,
  currentFilePath: string,
): DefinitionResult | undefined {
  const reading = readRefScalar(scalar, text);
  if (!reading) return undefined;
  const lineOffsets = buildLineOffsets(text);
  const locate = (span: [number, number]): DefinitionResult => ({
    uri: currentFilePath,
    range: { start: offsetToPosition(span[0], lineOffsets), end: offsetToPosition(span[1], lineOffsets) },
  });
  const loops = forEachLoops(doc);

  // `[binding.member]` of each index, brackets included.
  const index = reading.bindings.findIndex(
    (span, i) => offset >= span[0] - 1 && offset <= span[1] + reading.indexes[i]!.member.length + 2,
  );
  if (index >= 0) {
    const loop = loopBinding(loops, reading.indexes[index]!.binding, scalar.range[0]);
    if (!loop) return undefined;
    return locate(loop.asRange ?? [loop.map.range[0], loop.map.range[0]]);
  }

  const inDocument = reading.indexes.length > 0 ? loops.find((l) => l.family?.name === reading.name) : undefined;
  if (inDocument?.family) return locate(inDocument.family.range);
  const alias = reading.alias;
  return resolveRefTarget(graph, currentModule, {
    ...(alias !== undefined ? { alias } : {}),
    name: reading.name,
    onAlias: alias !== undefined && offset < reading.head[0],
  });
}

const NOT_A_MODULE_CALL = Symbol("not a module call");

/**
 * A module call under the cursor navigates to the callable resource it binds
 * to — resolved the way a `!ref` of the same spelling is, since a call names a
 * resource through the same grammar — and its alias to the import declaring it.
 * Needs the analysis: which receivers are modules is the scope's answer.
 */
function moduleCallTarget(
  graph: LoadedGraph,
  currentModule: LoadedModule,
  text: string,
  docs: AstDocument[],
  resolved: NonNullable<ReturnType<typeof resolveNodeAtPosition>>,
  analysis: ManifestAnalysis | undefined,
): DefinitionResult | undefined | typeof NOT_A_MODULE_CALL {
  const query = analysis?.celScope;
  if (!resolved.cel || !query) return NOT_A_MODULE_CALL;
  const identity = docIdentity(docs[resolved.docIndex]);
  const resource = query.resourceFor(identity.kind, identity.name);
  if (!resource) return NOT_A_MODULE_CALL;
  let ast: CelNode;
  try {
    ast = resolved.cel.segment.ast();
  } catch (error) {
    if (!(error instanceof CelParseError)) throw error;
    return NOT_A_MODULE_CALL;
  }
  const scope = query.scopeAt(resource, resolved.concretePath ?? "");
  const call = moduleCallAt(text, ast, resolved.cel.offset, scope);
  if (!call) return NOT_A_MODULE_CALL;
  const imported = graph.importEdges.get(currentModule.owner.source)?.has(call.receiver) === true;
  if (call.onReceiver) return imported ? locateImport(currentModule, call.receiver) : undefined;
  if (!scope.moduleFunction(call.qualified)) return undefined;
  return resolveRefTarget(graph, currentModule, {
    ...(imported ? { alias: call.receiver } : {}),
    name: call.name,
    onAlias: false,
  });
}

/**
 * Where a `Run` step is declared.
 *
 * The one CEL scope whose members really are written in the manifest but are
 * reached through no reference slot — `steps.encode.result` names something a
 * `!ref` resolver has never heard of. Finding it needs the declaring kind's own
 * step-body annotation, which is why it goes through the scope query rather
 * than through the graph navigation the other CEL roots use.
 */
import type { AstDocument, CelScopeQuery, LoadedFile, LoadedGraph } from "@telorun/analyzer";
import type { DefinitionResult } from "../types.js";
import { docIdentity } from "../doc-identity.js";

/** The loaded file for `filePath`, whose position index maps a manifest path to
 *  a source range. */
function loadedFile(graph: LoadedGraph, filePath: string): LoadedFile | undefined {
  for (const mod of graph.modules.values()) {
    if (mod.owner.source === filePath) return mod.owner;
    const partial = mod.partials.find((p) => p.source === filePath);
    if (partial) return partial;
  }
  return undefined;
}

export function locateStepDeclaration(
  graph: LoadedGraph,
  filePath: string,
  docs: AstDocument[],
  docIndex: number,
  stepName: string,
  scopeQuery: CelScopeQuery | undefined,
): DefinitionResult | undefined {
  if (!scopeQuery) return undefined;
  const identity = docIdentity(docs[docIndex]);
  const resource = scopeQuery.resourceFor(identity.kind, identity.name);
  if (!resource) return undefined;

  const stepPath = scopeQuery.stepDeclarationPath(resource, stepName);
  if (!stepPath) return undefined;

  const file = loadedFile(graph, filePath);
  const index = file?.positions[docIndex]?.positionIndex;
  if (!index) return undefined;
  // The step's own `name:` value is what the jump underlines — the step object's
  // range would highlight the whole block, which reads as a selection rather
  // than as a declaration.
  const range =
    index.get(`${stepPath}.name`) ?? index.get(`@key:${stepPath}.name`) ?? index.get(stepPath);
  return range ? { uri: file!.source, range } : undefined;
}

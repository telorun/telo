/**
 * Where a CEL context binding was declared.
 *
 * `request.query` is written in the route's own `request.schema`, `self.<field>`
 * in the definition's `schema`, `result.<field>` in the INVOKED resource's
 * `outputType` — each derived by an `x-telo-context-*` annotation rather than
 * reached through a reference slot, so none of them is navigable by the graph
 * walk the other CEL roots use. The scope query resolves the annotation to a
 * manifest identity plus a path; locating that path in the loaded files is what
 * this adds.
 */
import type { AstDocument, CelScopeQuery, LoadedFile, LoadedGraph } from "@telorun/analyzer";
import type { DefinitionResult } from "../types.js";
import { docIdentity } from "../doc-identity.js";

/** Every file of every module in the graph — a binding's declaration may sit in
 *  another module (an invoked handler's `outputType`), so the search is not
 *  confined to the current file. */
function allFiles(graph: LoadedGraph): LoadedFile[] {
  const out: LoadedFile[] = [];
  for (const mod of graph.modules.values()) out.push(mod.owner, ...mod.partials);
  return out;
}

export function locateContextBinding(
  graph: LoadedGraph,
  docs: AstDocument[],
  docIndex: number,
  sitePath: string,
  parts: string[],
  scopeQuery: CelScopeQuery | undefined,
): DefinitionResult | undefined {
  if (!scopeQuery) return undefined;
  const identity = docIdentity(docs[docIndex]);
  const resource = scopeQuery.resourceFor(identity.kind, identity.name);
  if (!resource) return undefined;

  const site = scopeQuery.contextDeclarationSite(resource, sitePath, parts);
  if (!site) return undefined;

  for (const file of allFiles(graph)) {
    for (let i = 0; i < file.manifests.length; i++) {
      const manifest = file.manifests[i] as { kind?: string; metadata?: { name?: string } } | null;
      if (manifest?.kind !== site.kind || manifest.metadata?.name !== site.name) continue;
      const index = file.positions[i]?.positionIndex;
      // The KEY span, so the jump underlines `query:` rather than the block that
      // follows it — a declaration, not a selection.
      const range = index?.get(`@key:${site.path}`) ?? index?.get(site.path);
      if (range) return { uri: file.source, range };
    }
  }
  return undefined;
}

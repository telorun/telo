import {
  isModuleKind,
  rangeInterval,
  readRequires,
  type LoadedGraph,
} from "@telorun/analyzer";
import type { RequirementsParams, RequirementsRange } from "@telorun/editor-protocol";
import { uriOfSource } from "./document-uri.js";

/**
 * What `telo/requirements` says about one analysed owner: which documents are
 * its members, and every `requires: telo:` range its import closure declares —
 * read through the analyzer's single reader, so a range the gate would refuse
 * as malformed is not handed to a host as a constraint either. A module the
 * version reconciliation repointed away from is not in the closure.
 */
export function requirementsOf(owner: string, graph: LoadedGraph): RequirementsParams {
  const module = [...graph.modules.values()].find((m) => m.owner.source === owner) ?? graph.entry;
  const ranges: RequirementsRange[] = [];
  for (const [source, loaded] of graph.modules) {
    if (graph.overrides.has(source)) continue;
    const doc = loaded.owner.manifests.find((m) => m && isModuleKind(m.kind));
    if (!doc) continue;
    const telo = readRequires(doc as unknown as Record<string, unknown>).block.telo;
    if (!telo) continue;
    ranges.push({
      module: uriOfSource(loaded.owner.source),
      text: telo.raw,
      interval: rangeInterval(telo),
    });
  }
  return {
    owner: uriOfSource(owner),
    documents: [module.owner, ...module.partials].map((file) => uriOfSource(file.source)),
    ranges,
  };
}

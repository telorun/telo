import {
  isModuleKind,
  loadRange,
  rangeInterval,
  readModuleRequirements,
  type LoadedGraph,
  type VersionRange,
} from "@telorun/analyzer";
import type { RequirementsParams, RequirementsRange } from "@telorun/editor-protocol";
import { uriOfSource } from "./document-uri.js";

/** The lower edge reported for `>=unreleased`: above every engine identity, so
 *  no known version meets it and selection falls to the bundled engine as for
 *  any unsatisfiable range. */
const UNRELEASED_EDGE = "999999.0.0";

/**
 * What `telo/requirements` says about one analysed owner: which documents are
 * its members, and every `requires: telo:` range its import closure declares —
 * the module's LOAD range on the telo axis (its own `requires:` narrowed by its
 * own covering `restrictions:` entries), read through the analyzer's single
 * reader, so a range the gate would refuse as malformed is not handed to a host
 * as a constraint either. The owner's own `telo` ceiling is not enforced by the
 * gate and so not reported; a published dependency's is. A module the
 * version reconciliation repointed away from is not in the closure.
 */
export function requirementsOf(owner: string, graph: LoadedGraph): RequirementsParams {
  const module = [...graph.modules.values()].find((m) => m.owner.source === owner) ?? graph.entry;
  const ranges: RequirementsRange[] = [];
  for (const [source, loaded] of graph.modules) {
    if (graph.overrides.has(source)) continue;
    const doc = loaded.owner.manifests.find((m) => m && isModuleKind(m.kind));
    if (!doc) continue;
    const constraints = loadRange(readModuleRequirements(doc as unknown as Record<string, unknown>), {
      ownCeiling: loaded.owner.source !== owner,
    }).filter((c) => c.key === "telo");
    if (constraints.length === 0) continue;
    const combined: VersionRange = {
      raw: constraints.map((c) => c.range.raw).join(" "),
      comparators: constraints.flatMap((c) => c.range.comparators),
    };
    const interval = rangeInterval(combined);
    ranges.push({
      module: uriOfSource(loaded.owner.source),
      text: combined.raw,
      interval: constraints.some((c) => c.range.unreleased)
        ? { ...interval, min: { version: UNRELEASED_EDGE, inclusive: true } }
        : interval,
    });
  }
  return {
    owner: uriOfSource(owner),
    documents: [module.owner, ...module.partials].map((file) => uriOfSource(file.source)),
    ranges,
  };
}

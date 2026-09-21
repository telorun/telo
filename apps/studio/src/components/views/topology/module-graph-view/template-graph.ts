import {
  inheritedCapability,
  templateModule,
  type AnalysisRegistry,
  type ManifestAnalysis,
  type ModuleGraph,
} from "@telorun/analyzer";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isModuleRootKind } from "../../../../application-adapter";

/**
 * A templated kind's body, drawn as a module — see the analyzer's
 * `templateModule`. The graph is built by the SAME projection the module canvas
 * draws from, over the analyzed definition, against the closure's registry, so
 * a box inside the body and a box at top level cannot disagree about what a
 * kind's slots are.
 */
export interface TemplateGraph {
  /** Canonical `<module>.<Name>` of the kind. */
  kindId: string;
  name: string;
  module?: string;
  /** The kind's capability, inherited along `extends` where it declares none. */
  capability?: string;
  /** The definition as analyzed — what a read-only body is read from, where
   *  the workspace holds no document to edit. */
  definition: ResourceManifest;
  graph: ModuleGraph;
}

/** Built once per analysis, since the analysis is rebuilt on every edit. */
const memo = new WeakMap<ManifestAnalysis, Map<string, TemplateGraph | null>>();

/** The body of the kind `kindId`, or null when no templated definition in the
 *  analyzed closure declares it. */
export function templateGraphOf(
  analysis: ManifestAnalysis,
  registry: AnalysisRegistry,
  kindId: string,
): TemplateGraph | null {
  let byKind = memo.get(analysis);
  if (!byKind) memo.set(analysis, (byKind = new Map()));
  if (byKind.has(kindId)) return byKind.get(kindId)!;
  const built = build(analysis, registry, kindId);
  byKind.set(kindId, built);
  return built;
}

function build(
  analysis: ManifestAnalysis,
  registry: AnalysisRegistry,
  kindId: string,
): TemplateGraph | null {
  const definition = analysis.manifests.find(
    (m) => m.kind === "Telo.Definition" && canonicalIdOf(m) === kindId,
  );
  if (!definition) return null;
  const module = (definition.metadata as { module?: string } | undefined)?.module;
  const moduleDoc = analysis.manifests.find(
    (m) => isModuleRootKind(m.kind as string) && (!module || m.metadata?.name === module),
  );
  const body = templateModule(definition, moduleDoc, analysis.manifests);
  const manifests = [...body.resources, body.root];
  const graph = registry
    .analysisOf(manifests)
    .moduleGraph(registry.moduleGraphDeps(manifests, body.options), body.options);
  const asDefinition = definition as unknown as ResourceDefinition;
  const capability = inheritedCapability(asDefinition, registry.resolverForDefinition(asDefinition));
  return {
    kindId,
    name: definition.metadata?.name as string,
    ...(module ? { module } : {}),
    ...(capability ? { capability } : {}),
    definition,
    graph,
  };
}

/** The kind plane's id for a definition — `<module>.<Name>`, or the bare name
 *  where the loader stamped no module. */
function canonicalIdOf(definition: ResourceManifest): string | undefined {
  const name = definition.metadata?.name;
  if (typeof name !== "string") return undefined;
  const module = (definition.metadata as { module?: string } | undefined)?.module;
  return module ? `${module}.${name}` : name;
}

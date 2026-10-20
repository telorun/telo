import {
  inheritedCapability,
  isModuleKind,
  templateModule,
  type AnalysisRegistry,
  type ManifestAnalysis,
} from "@telorun/analyzer";
import type { TemplateGraphData } from "@telorun/editor-protocol";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { moduleGraphData } from "./module-graph-data.js";
import { outputCandidates, outputRefusalsOf, type KindOutputSlot } from "./output-refusals.js";

/**
 * The body of the templated kind `kindId`, drawn as a module by the same
 * projection the module graph comes from — the analyzer's `templateModule` —
 * against the closure's registry, with each output-constrained slot's verdict
 * over the body's own entries. Null when no `Telo.Definition` in the analysed
 * set declares it.
 */
export function templateGraphOf(
  analysis: ManifestAnalysis,
  registry: AnalysisRegistry,
  kindId: string,
  uriOfSource: (source: string) => string,
  outputSlots: readonly KindOutputSlot[],
): TemplateGraphData | null {
  const definition = analysis.manifests.find(
    (m) => m.kind === "Telo.Definition" && canonicalIdOf(m) === kindId,
  );
  if (!definition) return null;
  const module = (definition.metadata as { module?: string } | undefined)?.module;
  const moduleDoc = analysis.manifests.find(
    (m) => isModuleKind(m.kind) && (!module || m.metadata?.name === module),
  );
  const body = templateModule(definition, moduleDoc, analysis.manifests);
  const manifests = [...body.resources, body.root];
  const bodyAnalysis = registry.analysisOf(manifests);
  const graph = bodyAnalysis.moduleGraph(registry.moduleGraphDeps(manifests, body.options), body.options);
  const asDefinition = definition as unknown as ResourceDefinition;
  const capability = inheritedCapability(asDefinition, registry.resolverForDefinition(asDefinition));
  return {
    kindId,
    name: definition.metadata?.name as string,
    ...(module ? { module } : {}),
    ...(capability ? { capability } : {}),
    definition: withSourceUris(definition, uriOfSource) as Record<string, unknown>,
    graph: moduleGraphData(graph),
    outputRefusals: outputRefusalsOf(bodyAnalysis, outputSlots, outputCandidates(body.resources)),
  };
}

/** `<module>.<Name>`, or the bare name where the loader stamped no module. */
function canonicalIdOf(definition: ResourceManifest): string | undefined {
  const name = definition.metadata?.name;
  if (typeof name !== "string") return undefined;
  const module = (definition.metadata as { module?: string } | undefined)?.module;
  return module ? `${module}.${name}` : name;
}

/** A plain copy of `value` in which every `metadata.source` the loader stamped
 *  is the document URI a host knows the file by. */
function withSourceUris(value: unknown, uriOfSource: (source: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => withSourceUris(item, uriOfSource));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    out[key] = withSourceUris(child, uriOfSource);
  }
  const metadata = out.metadata as Record<string, unknown> | undefined;
  if (metadata && typeof metadata === "object" && typeof metadata.source === "string") {
    out.metadata = { ...metadata, source: uriOfSource(metadata.source) };
  }
  return out;
}

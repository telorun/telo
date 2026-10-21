import {
  isModuleKind,
  isRefSlot,
  kindDeclarationOf,
  readRefSlot,
  type AnalysisRegistry,
  type LoadedGraph,
  type ManifestAnalysis,
  type ModuleGraph,
  type RefSlot,
} from "@telorun/analyzer";
import type {
  KindContract,
  ModuleGraphData,
  RefConstraint,
  TemplateGraphData,
  ViewModel,
} from "@telorun/editor-protocol";
import type { ResourceManifest } from "@telorun/sdk";
import { moduleGraphData } from "./module-graph-data.js";
import { declaredOutputSlots, outputCandidates, outputRefusalsOf } from "./output-refusals.js";
import { referenceSitesOf } from "./reference-sites.js";
import { templateGraphOf } from "./template-graphs.js";

export interface ViewModelInput {
  /** The owner module's document URI. */
  owner: string;
  revision: number;
  /** The owner's import closure, rooted at the owner. */
  graph: LoadedGraph;
  registry: AnalysisRegistry;
  analysis: ManifestAnalysis;
  /** The document URI of an analyzer source. */
  uriOfSource: (source: string) => string;
  /** Document URI → the LSP version of each open document the analysis read. */
  documents: Record<string, number>;
}

/**
 * The structured-view model of one owner module, as plain JSON — every answer
 * the registry and the analysis give, asked once for everything a structured
 * editor reads, so a host holding it needs no analyzer of its own.
 */
export function buildViewModel(input: ViewModelInput): ViewModel {
  const { registry, analysis } = input;
  const graph = ownerModuleGraph(input);
  const outputSlots = declaredOutputSlots(registry, analysis.manifests);

  const templates: Record<string, TemplateGraphData> = {};
  for (const kind of graph?.kinds ?? []) {
    if (!kind.template) continue;
    const template = templateGraphOf(analysis, registry, kind.id, input.uriOfSource, outputSlots);
    if (template) templates[kind.id] = template;
  }
  const graphs = [graph, ...Object.values(templates).map((t) => t.graph)];

  const constraints = new Set(declaredRefSlots(registry, analysis.manifests).flatMap((slot) => slot.kinds));
  for (const data of graphs) {
    if (data) for (const kind of graphConstraints(data)) constraints.add(kind);
  }
  const refConstraints: Record<string, RefConstraint> = {};
  for (const constraint of [...constraints].sort()) {
    const accepted = registry.acceptedKindsForRef(constraint);
    if (!accepted) continue;
    refConstraints[constraint] = {
      accepted: [...accepted].sort(),
      userFacing: registry.userFacingKindsForRef(constraint) ?? [],
    };
  }

  // Resolved in the owner's scope first; a spelling only a graph node carries
  // (an entry of another module's template body) is the node's own resolution.
  const resolved = new Map<string, string>();
  const spellings = new Set<string>(Object.keys(refConstraints));
  for (const constraint of Object.values(refConstraints)) for (const s of constraint.userFacing) spellings.add(s);
  for (const m of analysis.manifests) if (typeof m.kind === "string") spellings.add(m.kind);
  for (const data of graphs) for (const node of data?.nodes ?? []) spellings.add(node.kind);
  for (const spelling of spellings) {
    const canonical = registry.resolveKind(spelling);
    if (canonical) resolved.set(spelling, canonical);
  }
  for (const data of graphs) {
    for (const node of data?.nodes ?? []) {
      if (resolved.has(node.kind) || node.unknownKind) continue;
      resolved.set(node.kind, node.canonicalKind ?? node.kind);
    }
  }
  const kindSpellings: Record<string, string> = {};
  for (const spelling of [...resolved.keys()].sort()) kindSpellings[spelling] = resolved.get(spelling)!;

  const contracts: Record<string, KindContract> = {};
  for (const kind of registry.allKinds()) {
    const inputType = registry.inputTypeForKind(kind);
    const outputType = registry.outputTypeForKind(kind);
    if (!inputType && !outputType) continue;
    contracts[kind] = { ...(inputType ? { inputType } : {}), ...(outputType ? { outputType } : {}) };
  }

  const root = input.graph.entry.owner.manifests.find((m) => m && isModuleKind(m.kind));
  const rootDefinition = root
    ? registry.resolveDefinitionIn(root.kind, (root.metadata as { module?: string }).module)
    : undefined;

  return {
    owner: input.owner,
    revision: input.revision,
    moduleGraph: graph,
    moduleRootSchema: (rootDefinition?.schema as Record<string, unknown> | undefined) ?? null,
    kindSpellings,
    refConstraints,
    contracts,
    outputRefusals: outputRefusalsOf(
      analysis,
      outputSlots,
      outputCandidates([input.graph.entry.owner, ...input.graph.entry.partials].flatMap((file) => file.manifests)),
    ),
    templates,
    referenceSites: referenceSitesOf(registry, input.graph.entry),
    documents: input.documents,
  };
}

/** The owner drawn as a module, rooted at its own module document. */
function ownerModuleGraph({ graph, registry, analysis }: ViewModelInput): ModuleGraphData | null {
  const rootDoc = analysis.manifests.find(
    (m) =>
      isModuleKind(m.kind) &&
      (m.metadata as { source?: string }).source === graph.entry.owner.source,
  );
  const entryModule = rootDoc?.metadata?.name as string | undefined;
  const options = {
    ...(rootDoc ? { root: rootDoc } : {}),
    ...(entryModule ? { entryModule } : {}),
  };
  const built: ModuleGraph = analysis.moduleGraph(registry.moduleGraphDeps(analysis.manifests, options), options);
  return moduleGraphData(built);
}

/** Every reference slot an analysed kind declares — each registered
 *  definition's schema as registered, and each kind document's as analysed. */
function declaredRefSlots(registry: AnalysisRegistry, manifests: readonly ResourceManifest[]): RefSlot[] {
  const schemas: unknown[] = registry.allKinds().map((kind) => registry.resolveDefinition(kind)?.schema);
  for (const m of manifests) schemas.push(kindDeclarationOf(m)?.schema);
  const slots: RefSlot[] = [];
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (!Array.isArray(node) && isRefSlot(node as Record<string, any>)) {
      slots.push(readRefSlot(node as Record<string, any>)!);
    }
    for (const child of Object.values(node)) walk(child);
  };
  for (const schema of schemas) walk(schema);
  return slots;
}

/** The constraints a graph's ports and dispatch sites name. */
function graphConstraints(graph: ModuleGraphData): string[] {
  const out: string[] = [];
  for (const node of graph.nodes) {
    for (const port of node.ports) out.push(...port.refs);
    for (const row of node.rows) {
      if (!row.dispatch) continue;
      out.push(...row.dispatch.refs);
      for (const alternative of row.dispatch.alternatives ?? []) out.push(...alternative.refs);
    }
  }
  return out;
}

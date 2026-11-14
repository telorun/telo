import type { ResourceManifest } from "@telorun/sdk";
import { AnalysisRegistry } from "./analysis-registry.js";
import { StaticAnalyzer } from "./analyzer.js";
import { collectApplicationSources } from "./child-application.js";
import {
  analyzeDependencies,
  withoutCoveredArtifactWarnings,
  withoutCoveredDependencyFindings,
  type DependencyAnalysis,
  type DependencyAnalysisOptions,
} from "./dependency-verdicts.js";
import { unionDiagnostics } from "./diagnostic-identity.js";
import { collectModuleDocuments, flattenForAnalyzer } from "./flatten-for-analyzer.js";
import { assembleGraphDiagnostics } from "./graph-diagnostics.js";
import type { LoadedGraph } from "./loaded-types.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

export interface GraphAnalysisOptions extends Omit<DependencyAnalysisOptions, "entryManifests"> {
  /** The registry the entry's analysis fills; a fresh one by default. */
  registry?: AnalysisRegistry;
}

/** A loaded graph judged whole: the entry's own analysis and every library's
 *  verdict, assembled as every host presents them. */
export interface GraphAnalysis {
  /** The entry's flattened set the analysis ran over. */
  readonly manifests: ResourceManifest[];
  readonly registry: AnalysisRegistry;
  /** The entry analysis's own output, before assembly. */
  readonly analysis: AnalysisDiagnostic[];
  readonly dependencies: DependencyAnalysis;
  /** What to report: the graph's load findings, the entry's live analysis and
   *  every library's verdict, each identity once. */
  readonly diagnostics: AnalysisDiagnostic[];
  /** The entry's analysis cascade held back on compromised files. */
  readonly suppressed: AnalysisDiagnostic[];
  /** The errors of `diagnostics`: what a load is refused with. */
  readonly errors: AnalysisDiagnostic[];
}

/** Analyze `graph` as `telo check` does: the entry, then every library it
 *  loads by that library's own verdict. */
export async function analyzeLoadedGraph(
  graph: LoadedGraph,
  options: GraphAnalysisOptions = {},
): Promise<GraphAnalysis> {
  const analyzer = options.analyzer ?? new StaticAnalyzer();
  const registry = options.registry ?? new AnalysisRegistry();
  const manifests = flattenForAnalyzer(graph);
  const analysis = analyzer.analyze(
    manifests,
    {
      moduleDocuments: collectModuleDocuments(graph),
      applicationSources: collectApplicationSources(graph),
      ...(options.hostVersions ? { hostVersions: options.hostVersions } : {}),
    },
    registry,
  );
  const dependencies = await analyzeDependencies(graph, { ...options, analyzer, entryManifests: manifests });
  const assembled = assembleGraphDiagnostics(graph, withoutCoveredDependencyFindings(analysis, dependencies));
  const diagnostics = unionDiagnostics(
    assembled.diagnostics,
    withoutCoveredArtifactWarnings(dependencies, assembled.diagnostics),
  );
  return {
    manifests,
    registry,
    analysis,
    dependencies,
    diagnostics,
    suppressed: assembled.suppressed,
    errors: diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error),
  };
}

import {
  choiceScopeOf,
  collectModuleDocuments,
  inputRequirements,
  needGraphFromLoadedGraph,
  needGraphScopeOf,
  readChoices,
  requirementDimensions,
  resolveNeedTable,
  DiagnosticSeverity,
  type AnalysisDiagnostic,
  type InputRequirements,
  type LoadedGraph,
  type NeedTable,
  type NeedTypeShape,
  type RequirementDimension,
} from "@telorun/analyzer";
import { isExpansionSentinel } from "@telorun/templating";
import { loadAnalyzedGraph, printRefusals } from "./analyzed-graph.js";
import type { Logger } from "./logger.js";
import type { ManifestInput } from "./manifest-input.js";
import { outErrLine } from "./output.js";

export interface LoadedNeedTable {
  /** What the command was handed, resolved — a packaged executable included. */
  input: ManifestInput;
  entryPath: string;
  graph: LoadedGraph;
  /** The root `Telo.Application` document. */
  root: Record<string, any>;
  table: NeedTable;
  /** Which inputs and needs each configuration requires, and the dimensions
   *  that is decided over with the environment variables each is read from —
   *  the verdict the kernel demands inputs by. */
  requirements: InputRequirements;
  dimensions: RequirementDimension[];
  /** The need type a canonical kind registers, in the graph's registry. */
  needType(kind: string): NeedTypeShape | undefined;
}

/**
 * Load an application's graph and resolve its need table over the whole graph,
 * with nothing booted — what every command describing an application's
 * environment reads. Every refusal the kernel would raise at load refuses here
 * too: it is printed on stderr, `process.exitCode` is set, and the result is
 * `undefined`. `product` names what the caller would have produced, for the
 * closing line ("it has no needs report").
 */
export async function loadNeedTable(
  manifest: string,
  log: Logger,
  product: string,
): Promise<LoadedNeedTable | undefined> {
  const analyzed = await loadAnalyzedGraph(manifest, log);
  if (!analyzed) return undefined;
  const { input, entryPath, graph, registry, errors } = analyzed;
  const root = graph.entry.owner.manifests.find((m) => m?.kind === "Telo.Application");
  if (!root) {
    outErrLine(
      `${log.err.error("error")}  ${entryPath} is not a Telo.Application — the ${product} ` +
        `describes what an application being run reads from the environment.`,
    );
    process.exitCode = 1;
    return undefined;
  }

  const scope = needGraphScopeOf(registry, root.metadata?.name as string | undefined);
  const table = resolveNeedTable(needGraphFromLoadedGraph(graph, scope));
  const refusals: AnalysisDiagnostic[] = [
    ...errors,
    ...table.problems
      .filter(
        (p) =>
          !p.reportedElsewhere &&
          !errors.some((e) => e.code === p.code && e.message === p.message),
      )
      .map((p) => ({
        severity: DiagnosticSeverity.Error,
        code: p.code,
        source: "telo-analyzer",
        message: p.message,
        data: { resource: p.resource, filePath: p.filePath, path: p.path },
      })),
  ];
  if (refusals.length > 0) {
    printRefusals(analyzed, refusals, log, "application", product);
    return undefined;
  }
  const { manifests, registry: analysis } = analyzed;
  const declarations = manifests.filter((m) => !isExpansionSentinel(m));
  const choices = readChoices(
    declarations,
    manifests.filter(isExpansionSentinel),
    choiceScopeOf(declarations, analysis, undefined, table),
  );
  const requirements = inputRequirements(manifests, choices, table, collectModuleDocuments(graph));
  const dimensions = requirementDimensions(requirements, root, table.environment);
  return { input, entryPath, graph, root, table, requirements, dimensions, needType: scope.needType };
}

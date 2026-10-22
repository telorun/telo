import {
  needGraphFromLoadedGraph,
  needGraphScopeOf,
  resolveNeedTable,
  DiagnosticSeverity,
  type AnalysisDiagnostic,
  type LoadedGraph,
  type NeedTable,
  type NeedTypeShape,
} from "@telorun/analyzer";
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
  return { input, entryPath, graph, root, table, needType: scope.needType };
}

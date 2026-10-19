import {
  AnalysisRegistry,
  StaticAnalyzer,
  collectModuleDocuments,
  flattenForAnalyzer,
  needGraphFromLoadedGraph,
  needGraphScopeOf,
  resolveNeedTable,
  DiagnosticSeverity,
  type AnalysisDiagnostic,
  type LoadedGraph,
  type NeedTable,
} from "@telorun/analyzer";
import { nodeHostVersions } from "@telorun/kernel";
import {
  cacheTargetFor,
  loadFreshGraph,
  openSession,
  resolveEntryPath,
} from "./check-session.js";
import { resolveLocation, type Logger } from "./logger.js";
import { outErrLine } from "./output.js";

export interface LoadedNeedTable {
  entryPath: string;
  graph: LoadedGraph;
  /** The root `Telo.Application` document. */
  root: Record<string, any>;
  table: NeedTable;
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
  const entryPath = resolveEntryPath(manifest);
  const target = cacheTargetFor(entryPath);
  const session = openSession(target ? [target] : []);
  const { graph } = await loadFreshGraph(entryPath, session, log);

  const loadFailures = [
    ...graph.errors.map((e) => e.error.message),
    ...graph.parseDiagnostics.map((d) => d.message),
  ];
  if (loadFailures.length > 0) {
    for (const message of loadFailures) outErrLine(`${log.err.error("error")}  ${message}`);
    process.exitCode = 1;
    return undefined;
  }
  const root = graph.entry.owner.manifests.find((m) => m?.kind === "Telo.Application");
  if (!root) {
    outErrLine(
      `${log.err.error("error")}  ${entryPath} is not a Telo.Application — the ${product} ` +
        `describes what an application being run reads from the environment.`,
    );
    process.exitCode = 1;
    return undefined;
  }

  const registry = new AnalysisRegistry();
  const errors = new StaticAnalyzer()
    .analyze(
      flattenForAnalyzer(graph),
      { moduleDocuments: collectModuleDocuments(graph), hostVersions: nodeHostVersions() },
      registry,
    )
    .filter((d) => d.severity === DiagnosticSeverity.Error);
  const table = resolveNeedTable(
    needGraphFromLoadedGraph(
      graph,
      needGraphScopeOf(registry, root.metadata?.name as string | undefined),
    ),
  );
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
    for (const d of refusals) {
      const at = resolveLocation(graph, d, entryPath);
      outErrLine(
        `${at ? `${at}  ` : ""}${log.err.error("error")}  ${d.message}${d.code ? `  ${log.err.dim(String(d.code))}` : ""}`,
      );
    }
    outErrLine(
      `\n${refusals.length} error${refusals.length === 1 ? "" : "s"} — the application does not load, so it has no ${product}.`,
    );
    process.exitCode = 1;
    return undefined;
  }
  return { entryPath, graph, root, table };
}

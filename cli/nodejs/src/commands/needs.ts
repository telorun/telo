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
} from "@telorun/analyzer";
import { nodeHostVersions } from "@telorun/kernel";
import type { Argv } from "yargs";
import {
  cacheTargetFor,
  loadFreshGraph,
  openSession,
  resolveEntryPath,
} from "../check-session.js";
import { createLogger, resolveLocation, type Logger } from "../logger.js";
import { buildNeedsReport, type NeedsReport } from "../needs-report.js";
import { outErrLine, outLine, output } from "../output.js";

/**
 * `telo needs report <manifest>` — every need the application reads from the
 * environment, with nothing booted. The report is computed by the same need
 * table the kernel refuses a load with, so a manifest the kernel would refuse
 * has no report: its refusals are printed instead, and the command exits 1.
 */
async function runReport(argv: { manifest: string }): Promise<void> {
  const log = createLogger(false);
  const entryPath = resolveEntryPath(argv.manifest);
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
    return;
  }
  const root = graph.entry.owner.manifests.find((m) => m?.kind === "Telo.Application");
  if (!root) {
    outErrLine(
      `${log.err.error("error")}  ${entryPath} is not a Telo.Application — a needs report ` +
        `lists what an application being run reads from the environment.`,
    );
    process.exitCode = 1;
    return;
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
    printRefusals(refusals, graph, entryPath, log);
    process.exitCode = 1;
    return;
  }

  const report = buildNeedsReport(graph, table);
  if (output().isJson) {
    output().document(report);
    return;
  }
  printReport(report, log);
}

function printRefusals(
  refusals: readonly AnalysisDiagnostic[],
  graph: LoadedGraph,
  entryPath: string,
  log: Logger,
): void {
  for (const d of refusals) {
    const at = resolveLocation(graph, d, entryPath);
    outErrLine(
      `${at ? `${at}  ` : ""}${log.err.error("error")}  ${d.message}${d.code ? `  ${log.err.dim(String(d.code))}` : ""}`,
    );
  }
  outErrLine(
    `\n${refusals.length} error${refusals.length === 1 ? "" : "s"} — the application does not load, so it has no needs report.`,
  );
}

function printReport(report: NeedsReport, log: Logger): void {
  if (report.needs.length === 0) {
    outLine("No needs are read from the environment.");
    return;
  }
  report.needs.forEach((need, index) => {
    if (index > 0) outLine();
    const type = need.type.module ? `${need.type.name} (${need.type.module})` : need.type.name;
    outLine(`${need.path}  ${log.dim(type)}${need.optional ? `  ${log.dim("optional")}` : ""}`);
    outLine(`  declared by ${need.declaredBy}`);
    if (need.version !== null) outLine(`  version ${need.version}`);
    if (need.features.length > 0) outLine(`  features ${need.features.join(", ")}`);
    const parameters = need.parameters as Record<string, unknown>;
    if (Object.keys(parameters).length > 0) {
      outLine(`  parameters ${JSON.stringify(parameters)}`);
    }
    for (const [field, info] of Object.entries(need.fields)) {
      const marks = [
        info.envSource,
        info.required ? "required" : "optional",
        ...(info.sensitive ? ["sensitive"] : []),
      ];
      outLine(`  ${field}  ${info.env}  ${log.dim(marks.join(", "))}`);
    }
  });
}

export function needsCommand(yargs: Argv): Argv {
  return yargs.command(
    "needs <subcommand>",
    "Inspect what an application asks whoever runs it for",
    (y) =>
      y
        .command(
          "report <manifest>",
          "List every need the application reads from the environment, and the variable each field is read from — nothing is booted",
          (yy) =>
            yy.positional("manifest", {
              describe: "Path to the application's manifest, or a directory containing telo.yaml",
              type: "string",
              demandOption: true,
            }),
          async (argv) => {
            await runReport(argv as { manifest: string });
          },
        )
        .demandCommand(1, "Specify a needs subcommand (report)"),
    () => {},
  );
}

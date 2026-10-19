import type { Argv } from "yargs";
import { loadNeedTable } from "../load-need-table.js";
import { createLogger, type Logger } from "../logger.js";
import { buildNeedsReport, type NeedsReport } from "../needs-report.js";
import { outLine, output } from "../output.js";

/**
 * `telo needs report <manifest>` — every need the application reads from the
 * environment, with nothing booted. The report is computed by the same need
 * table the kernel refuses a load with, so a manifest the kernel would refuse
 * has no report: its refusals are printed instead, and the command exits 1.
 */
async function runReport(argv: { manifest: string }): Promise<void> {
  const log = createLogger(false);
  const loaded = await loadNeedTable(argv.manifest, log, "needs report");
  if (!loaded) return;

  const report = buildNeedsReport(loaded.graph, loaded.table);
  if (output().isJson) {
    output().document(report);
    return;
  }
  printReport(report, log);
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

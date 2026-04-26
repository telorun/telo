import { Loader, StaticAnalyzer } from "@telorun/analyzer";
import { LocalFileSource } from "@telorun/kernel";
import * as path from "path";
import type { Argv } from "yargs";
import { createLogger, formatAnalysisDiagnostics, formatDiagnostics, type Logger } from "../logger.js";

async function checkOne(
  inputPath: string,
  log: Logger,
): Promise<{ errorCount: number; warnCount: number }> {
  const isUrl = inputPath.startsWith("http://") || inputPath.startsWith("https://");
  const entryPath = isUrl ? inputPath : path.resolve(process.cwd(), inputPath);

  const loader = new Loader([new LocalFileSource()]);

  let manifests;
  try {
    manifests = await loader.loadManifests(entryPath);
  } catch (err) {
    const sourceLine = (err as any).sourceLine as number | undefined;
    const displayPath = isUrl ? entryPath : path.relative(process.cwd(), entryPath);
    const loc = sourceLine !== undefined ? `:${sourceLine + 1}` : "";
    formatDiagnostics(
      [{ message: err instanceof Error ? err.message : String(err) }],
      log,
      `${displayPath}${loc}`,
    );
    return { errorCount: 1, warnCount: 0 };
  }

  const diagnostics = new StaticAnalyzer().analyze(manifests);
  return formatAnalysisDiagnostics(diagnostics, manifests, log, entryPath);
}

export async function check(argv: { paths: string[] }): Promise<void> {
  const log = createLogger(false);

  let totalErrors = 0;
  let totalWarns = 0;

  for (const p of argv.paths) {
    const { errorCount, warnCount } = await checkOne(p, log);
    totalErrors += errorCount;
    totalWarns += warnCount;
  }

  if (totalErrors === 0 && totalWarns === 0) {
    console.log(log.ok("✓") + "  No issues found");
  } else {
    const parts: string[] = [];
    if (totalErrors > 0)
      parts.push(log.error(`${totalErrors} error${totalErrors !== 1 ? "s" : ""}`));
    if (totalWarns > 0) parts.push(log.warn(`${totalWarns} warning${totalWarns !== 1 ? "s" : ""}`));
    console.log(`\n${parts.join(", ")}`);
  }

  if (totalErrors > 0) process.exit(1);
}

export function checkCommand(yargs: Argv): Argv {
  return yargs.command(
    "check <paths..>",
    "Check one or more Telo manifests for errors without running them",
    (y) =>
      y.positional("paths", {
        describe: "Paths to YAML manifests, directories containing telo.yaml, or HTTP(S) URLs",
        type: "string",
        array: true,
        demandOption: true,
      }),
    async (argv) => {
      await check(argv as any);
    },
  );
}

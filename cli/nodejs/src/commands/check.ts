import type { PositionIndex } from "@telorun/analyzer";
import { DiagnosticSeverity, Loader, NodeAdapter, StaticAnalyzer } from "@telorun/analyzer";
import * as path from "path";
import type { Argv } from "yargs";
import { createLogger, formatDiagnostics, type Logger } from "../logger.js";

async function checkOne(
  inputPath: string,
  log: Logger,
): Promise<{ errorCount: number; warnCount: number }> {
  const isUrl = inputPath.startsWith("http://") || inputPath.startsWith("https://");
  const entryPath = isUrl ? inputPath : path.resolve(process.cwd(), inputPath);
  const cwd = isUrl ? process.cwd() : path.dirname(entryPath);

  const loader = new Loader([new NodeAdapter(cwd)]);

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

  const manifestByKey = new Map<string, (typeof manifests)[number]>();
  for (const m of manifests) {
    if (m.kind && m.metadata?.name) {
      manifestByKey.set(`${m.kind}.${m.metadata.name}`, m);
    }
  }

  let errorCount = 0;
  let warnCount = 0;

  for (const d of diagnostics) {
    const resource = (d.data as any)?.resource as { kind: string; name: string } | undefined;
    const m = resource ? manifestByKey.get(`${resource.kind}.${resource.name}`) : undefined;
    const absSource = (m?.metadata as any)?.source as string | undefined;
    const displaySource = absSource
      ? isUrl
        ? absSource
        : path.relative(process.cwd(), absSource)
      : isUrl
        ? entryPath
        : path.relative(process.cwd(), entryPath);
    const sourceLine = (m?.metadata as any)?.sourceLine as number | undefined;
    const positionIndex = (m?.metadata as any)?.positionIndex as PositionIndex | undefined;
    const fieldPath = (d.data as any)?.path as string | undefined;

    const fieldRange =
      fieldPath !== undefined && positionIndex ? positionIndex.get(fieldPath) : undefined;
    const line = (fieldRange?.start.line ?? sourceLine ?? 0) + 1;
    const col = (fieldRange?.start.character ?? 0) + 1;

    const loc = `${displaySource}:${line}:${col}`;
    const severityLabel =
      (d.severity ?? DiagnosticSeverity.Warning) <= DiagnosticSeverity.Error
        ? log.error("error")
        : log.warn("warning");
    const code = d.code ? `  ${log.dim(String(d.code))}` : "";

    console.log(`${loc}  ${severityLabel}  ${d.message}${code}`);

    if ((d.severity ?? DiagnosticSeverity.Warning) <= DiagnosticSeverity.Error) errorCount++;
    else warnCount++;
  }

  return { errorCount, warnCount };
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
        describe: "Paths to YAML manifests, directories containing module.yaml, or HTTP(S) URLs",
        type: "string",
        array: true,
        demandOption: true,
      }),
    async (argv) => {
      await check(argv as any);
    },
  );
}

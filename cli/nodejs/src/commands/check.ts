import { Loader, StaticAnalyzer, flattenForAnalyzer } from "@telorun/analyzer";
import { assembleGraphDiagnostics } from "@telorun/ide-support";
import { LocalFileSource } from "@telorun/kernel/manifest-sources/local-file-source";
import { defaultTransportRegistry } from "@telorun/kernel/transports";
import * as path from "path";
import type { Argv } from "yargs";
import { createLogger, formatAnalysisDiagnostics, formatDiagnostics, type Logger } from "../logger.js";

const DEFAULT_REGISTRY_URL = "https://registry.telo.run";

async function checkOne(
  inputPath: string,
  registryUrl: string,
  log: Logger,
): Promise<{ errorCount: number; warnCount: number }> {
  const isUrl = inputPath.startsWith("http://") || inputPath.startsWith("https://");
  const entryPath = isUrl ? inputPath : path.resolve(process.cwd(), inputPath);

  // The kernel's transport sources — the same set `install` / `run` use — so
  // `check` resolves every scheme they do, `oci://` included, direct-to-origin.
  // The browser-only `manifests.telo.sh` cache path stays the editor's; a CLI
  // resolves origin-direct so it never depends on the hub (federated-discovery
  // plan: resolution never routes through the hub).
  const loader = new Loader([
    new LocalFileSource(),
    ...defaultTransportRegistry(registryUrl).sources(),
  ]);

  try {
    // `desugarImports` so inline `imports:` maps expand into synthetic
    // Telo.Import manifests before analysis — `telo check` is a static
    // resolution consumer and must see inline imports exactly as the kernel does.
    const graph = await loader.loadGraph(entryPath, { desugarImports: true });
    const manifests = flattenForAnalyzer(graph);
    // `assembleGraphDiagnostics` is the shared assembler every host uses: it
    // folds parse, version-reconciliation, import-resolution, and static
    // analysis diagnostics into one list, holding back the cascade for files
    // that failed to parse or whose imports failed to resolve. A broken
    // `imports:` source thus surfaces here as a coded diagnostic — identical to
    // the editor — instead of a bare re-thrown load error. The CLI drops the
    // suppressed cascade; the editor / VS Code keep it available to render.
    const analysis = new StaticAnalyzer().analyze(manifests);
    const { diagnostics } = assembleGraphDiagnostics(graph, analysis);
    return formatAnalysisDiagnostics(diagnostics, graph, log, entryPath);
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
}

export async function check(argv: { paths: string[]; registryUrl?: string }): Promise<void> {
  const log = createLogger(false);

  // Same fallback chain as `run` / `install`.
  const registryUrl =
    argv.registryUrl ?? process.env.TELO_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;

  let totalErrors = 0;
  let totalWarns = 0;

  for (const p of argv.paths) {
    const { errorCount, warnCount } = await checkOne(p, registryUrl, log);
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
      y
        .positional("paths", {
          describe: "Paths to YAML manifests, directories containing telo.yaml, or HTTP(S) URLs",
          type: "string",
          array: true,
          demandOption: true,
        })
        .option("registry-url", {
          type: "string",
          describe: "Base URL for the telo module registry. Overrides TELO_REGISTRY_URL.",
        }),
    async (argv) => {
      await check(argv as any);
    },
  );
}

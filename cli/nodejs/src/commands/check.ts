import { StaticAnalyzer, collectModuleDocuments, flattenForAnalyzer } from "@telorun/analyzer";
import { assembleGraphDiagnostics } from "@telorun/ide-support";
import { nodeHostVersions, writeManifestCache } from "@telorun/kernel";
import * as path from "path";
import type { Argv } from "yargs";
import {
  cacheTargetFor,
  loadFreshGraph,
  openSession,
  resolveEntryPath,
  type CacheTarget,
  type CheckSession,
} from "../check-session.js";
import {
  createLogger,
  formatAnalysisDiagnostics,
  formatDiagnostics,
  type JsonDiagnostic,
  type Logger,
} from "../logger.js";
import { writeOriginDigests } from "../manifest-freshness.js";
import { outErrLine, output } from "../output.js";

interface CheckOutcome {
  errorCount: number;
  warnCount: number;
  /** The same diagnostics the text form printed, as data for `-o json`. */
  diagnostics: JsonDiagnostic[];
}

async function checkOne(
  inputPath: string,
  session: CheckSession,
  cacheTarget: CacheTarget | null,
  cacheWrite: boolean,
  log: Logger,
): Promise<CheckOutcome> {
  const entryPath = resolveEntryPath(inputPath);
  const isUrl = entryPath.startsWith("http://") || entryPath.startsWith("https://");

  try {
    // Freshness before analysis: a verdict computed from a moved tag would be
    // reported as authoritative.
    const { graph, digests } = await loadFreshGraph(entryPath, session, log);

    // `assembleGraphDiagnostics` is the shared assembler every host uses: it
    // folds parse, version-reconciliation, import-resolution, and static
    // analysis diagnostics into one list, holding back the cascade for files
    // that failed to parse or whose imports failed to resolve. A broken
    // `imports:` source thus surfaces here as a coded diagnostic — identical to
    // the editor — instead of a bare re-thrown load error. The CLI drops the
    // suppressed cascade; the editor / VS Code keep it available to render.
    // `moduleDocuments` carries each imported library's FULL documents, which
    // the flattened list drops — the zone stage derives an export's open
    // requirements from the library's own internal dispatch chain. No cache:
    // the CLI analyzes once per process.
    const analysis = new StaticAnalyzer().analyze(flattenForAnalyzer(graph), {
      moduleDocuments: collectModuleDocuments(graph),
      hostVersions: nodeHostVersions(),
    });
    const { diagnostics } = assembleGraphDiagnostics(graph, analysis);
    const counts = formatAnalysisDiagnostics(diagnostics, graph, log, entryPath);

    if (cacheWrite && cacheTarget) {
      // Write-through so the next check — and the next `telo run` from this
      // directory, which reads the same cache — is hermetic. Caching is an
      // optimization: a read-only filesystem warns rather than fails the check.
      try {
        await writeManifestCache(graph, cacheTarget.entryDir, cacheTarget.manifestsDir);
        await writeOriginDigests(cacheTarget.manifestsDir, digests);
      } catch (err) {
        outErrLine(
          `${log.err.warn(`[manifest-cache] write failed: ${err instanceof Error ? err.message : String(err)}`)}\n`,
        );
      }
    }

    return counts;
  } catch (err) {
    const sourceLine = (err as any).sourceLine as number | undefined;
    const displayPath = isUrl ? entryPath : path.relative(process.cwd(), entryPath);
    const loc = sourceLine !== undefined ? `:${sourceLine + 1}` : "";
    const message = err instanceof Error ? err.message : String(err);
    formatDiagnostics([{ message }], log, `${displayPath}${loc}`);
    // A load failure is a diagnostic like any other to a `-o json` consumer;
    // dropping it there would make the payload disagree with the exit code.
    return {
      errorCount: 1,
      warnCount: 0,
      diagnostics: [
        {
          file: displayPath,
          line: sourceLine !== undefined ? sourceLine + 1 : 1,
          column: 1,
          severity: "error",
          message,
        },
      ],
    };
  }
}

export async function check(argv: {
  paths: string[];
  cacheWrite?: boolean;
}): Promise<void> {
  const log = createLogger(false);

  const cacheWrite = argv.cacheWrite !== false;

  const cacheTargets = new Map<string, CacheTarget>();
  for (const p of argv.paths) {
    const target = cacheTargetFor(resolveEntryPath(p));
    if (target) cacheTargets.set(target.manifestsDir, target);
  }

  const session = openSession([...cacheTargets.values()]);

  let totalErrors = 0;
  let totalWarns = 0;
  const allDiagnostics: JsonDiagnostic[] = [];

  for (const p of argv.paths) {
    const cacheTarget = cacheTargetFor(resolveEntryPath(p));
    const outcome = await checkOne(p, session, cacheTarget, cacheWrite, log);
    totalErrors += outcome.errorCount;
    totalWarns += outcome.warnCount;
    allDiagnostics.push(...outcome.diagnostics);
  }

  const out = output();

  if (totalErrors === 0 && totalWarns === 0) {
    out.line(log.ok("✓") + "  No issues found");
  } else {
    const parts: string[] = [];
    if (totalErrors > 0)
      parts.push(log.error(`${totalErrors} error${totalErrors !== 1 ? "s" : ""}`));
    if (totalWarns > 0) parts.push(log.warn(`${totalWarns} warning${totalWarns !== 1 ? "s" : ""}`));
    out.line(`\n${parts.join(", ")}`);
  }

  // Emitted even when clean: an empty `diagnostics` array is the answer, and a
  // consumer must not have to treat "no output" as success.
  out.emit({
    ok: totalErrors === 0,
    errorCount: totalErrors,
    warnCount: totalWarns,
    diagnostics: allDiagnostics,
  });

  // `process.exitCode`, not `process.exit()`: the structured payload was just
  // written, and on a pipe `write` is asynchronous while `exit` does not flush. A
  // large diagnostic set exceeds the 64 KB pipe buffer, and truncated JSON is a
  // parse failure for the one consumer this format exists for. Returning lets
  // the event loop drain.
  if (totalErrors > 0) process.exitCode = 1;
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
        }),
    async (argv) => {
      await check(argv as any);
    },
  );
}

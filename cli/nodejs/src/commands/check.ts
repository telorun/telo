import {
  StaticAnalyzer,
  assembleGraphDiagnostics,
  collectApplicationSources,
  collectModuleDocuments,
  flattenForAnalyzer,
} from "@telorun/analyzer";
import { nodeHostVersions, writeManifestCache } from "@telorun/kernel";
import * as path from "path";
import type { Argv } from "yargs";
import {
  cacheTargetFor,
  loadFreshGraph,
  openSession,
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
import { probeControllerTools } from "../controller-tool-probe.js";
import { resolveManifestInput, type ManifestInput } from "../manifest-input.js";
import { writeOriginDigests } from "../manifest-freshness.js";
import { outErrLine, output } from "../output.js";

interface CheckOutcome {
  errorCount: number;
  warnCount: number;
  /** The same diagnostics the text form printed, as data for `-o json`. */
  diagnostics: JsonDiagnostic[];
}

async function checkOne(
  input: ManifestInput,
  session: CheckSession,
  cacheWrite: boolean,
  log: Logger,
): Promise<CheckOutcome> {
  const entryPath = input.entryPath;
  const isUrl = entryPath.startsWith("http://") || entryPath.startsWith("https://");
  const cacheTarget = cacheTargetFor(input);

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
      applicationSources: collectApplicationSources(graph),
      hostVersions: nodeHostVersions(),
    });
    const { diagnostics } = assembleGraphDiagnostics(graph, analysis);
    // Probing costs a process launch per tool the manifest actually calls for,
    // and nothing at all for a manifest of bundled controllers. A running app
    // never asks this question ahead of time; check is where it is affordable.
    diagnostics.push(...(await probeControllerTools(graph)));
    const counts = formatAnalysisDiagnostics(diagnostics, graph, log, entryPath);

    if (cacheWrite && cacheTarget && !cacheTarget.sealed) {
      // Write-through so the next check — and the next `telo run` from this
      // directory, which reads the same cache — is hermetic. Caching is an
      // optimization: a read-only filesystem warns rather than fails the check.
      // A sealed root is the binary's, and only a run of the application adds
      // to it.
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
    return loadFailure(displayPath, err, log, sourceLine);
  }
}

/** A path that did not load, as one diagnostic. A load failure is a diagnostic
 *  like any other to a `-o json` consumer; dropping it there would make the
 *  payload disagree with the exit code. */
function loadFailure(
  displayPath: string,
  err: unknown,
  log: Logger,
  sourceLine?: number,
): CheckOutcome {
  const loc = sourceLine !== undefined ? `:${sourceLine + 1}` : "";
  const message = err instanceof Error ? err.message : String(err);
  formatDiagnostics([{ message }], log, `${displayPath}${loc}`);
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

export async function check(argv: {
  paths: string[];
  cacheWrite?: boolean;
}): Promise<void> {
  const log = createLogger(false);

  const cacheWrite = argv.cacheWrite !== false;

  // Each path resolved once, before the sessions open: a packaged executable is
  // unpacked here. Every other path's cache root joins one shared session; a
  // packaged executable's sealed payload is a session of its own, so it neither
  // serves another path nor is served by one.
  const inputs: Array<{ path: string; input?: ManifestInput; failure?: unknown }> = [];
  for (const p of argv.paths) {
    try {
      inputs.push({ path: p, input: await resolveManifestInput(p) });
    } catch (failure) {
      inputs.push({ path: p, failure });
    }
  }

  const sharedTargets = new Map<string, CacheTarget>();
  for (const { input } of inputs) {
    const target = input ? cacheTargetFor(input) : null;
    if (target && !target.sealed) sharedTargets.set(target.manifestsDir, target);
  }
  const shared = openSession([...sharedTargets.values()]);
  const sessionFor = (input: ManifestInput): CheckSession => {
    const target = cacheTargetFor(input);
    return target?.sealed ? openSession([target]) : shared;
  };

  let totalErrors = 0;
  let totalWarns = 0;
  const allDiagnostics: JsonDiagnostic[] = [];

  for (const { path: p, input, failure } of inputs) {
    const outcome = input
      ? await checkOne(input, sessionFor(input), cacheWrite, log)
      : loadFailure(p, failure, log);
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
          describe:
            "Paths to YAML manifests, directories containing telo.yaml, packaged executables, or HTTP(S) URLs",
          type: "string",
          array: true,
          demandOption: true,
        }),
    async (argv) => {
      await check(argv as any);
    },
  );
}

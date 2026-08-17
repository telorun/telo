import {
  Loader,
  StaticAnalyzer,
  collectZoneModuleDocuments,
  flattenForAnalyzer,
} from "@telorun/analyzer";
import { assembleGraphDiagnostics } from "@telorun/ide-support";
import {
  LocalManifestCacheSource,
  nodeHostVersions,
  resolveCacheRoot,
  resolveEntryDir,
  writeManifestCache,
} from "@telorun/kernel";
import { LocalFileSource } from "@telorun/kernel/manifest-sources/local-file-source";
import { defaultTransportRegistry } from "@telorun/kernel/transports";
import * as fs from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";
import type { Argv } from "yargs";
import {
  createLogger,
  formatAnalysisDiagnostics,
  formatDiagnostics,
  type JsonDiagnostic,
  type Logger,
} from "../logger.js";
import { outErrLine, output } from "../output.js";
import {
  RecordingCacheSource,
  readOriginDigests,
  revalidateMutableOciRefs,
  writeOriginDigests,
} from "../manifest-freshness.js";

const DEFAULT_REGISTRY_URL = "https://registry.telo.run";

/** Where one input path's manifest cache lives. `null` for an HTTP(S) entry,
 *  which has no local anchor to hang a `.telo` directory off. */
interface CacheTarget {
  entryDir: string;
  manifestsDir: string;
}

function cacheTargetFor(entryPath: string): CacheTarget | null {
  const cacheRoot = resolveCacheRoot(entryPath);
  const entryDir = resolveEntryDir(entryPath);
  if (!cacheRoot || entryDir === null) return null;
  return { entryDir, manifestsDir: path.join(cacheRoot, "manifests") };
}

function resolveEntryPath(inputPath: string): string {
  const isUrl = inputPath.startsWith("http://") || inputPath.startsWith("https://");
  return isUrl ? inputPath : path.resolve(process.cwd(), inputPath);
}

interface CheckSession {
  loader: Loader;
  /** One recorder per distinct cache root, so the freshness pass can tell which
   *  manifests were served from disk and from which file. */
  recorders: RecordingCacheSource[];
  /** The `manifests` dir of every registered root, in the same order — the
   *  freshness pass judges a cached file against the record of the root it came
   *  from, which need not be the one this entry writes to. */
  manifestsDirs: string[];
  /** Mutable tags already probed in this invocation. Shared across input paths
   *  so a module imported by twenty manifests is `HEAD`ed once, not per file. */
  verified: Map<string, string>;
}

/**
 * One loader for the whole invocation, ahead of the transports:
 *
 *  - `LocalManifestCacheSource` makes a repeat check hermetic. Without it every
 *    `oci://` / registry import was re-pulled on every run even when fully
 *    pinned, which is the bulk of `check`'s wall time.
 *  - The loader is shared across *all* input paths, so `telo check a b c` reads
 *    a module common to several of them once. Its `urlToSource` / `fileCache`
 *    dedupe by canonical URL, so this is purely a cache-hit question — the
 *    resolution result for a given URL does not depend on which entry asked.
 *
 * A cache source is registered for every input path's cache root: the entries
 * are content-addressed, so a hit under any root is as good as a hit under the
 * one this path would write to, and a miss falls through unchanged.
 */
function openSession(cacheTargets: CacheTarget[], registryUrl: string): CheckSession {
  const recorders = cacheTargets.map(
    (t) =>
      new RecordingCacheSource(
        new LocalManifestCacheSource(t.entryDir, registryUrl, t.manifestsDir),
        registryUrl,
      ),
  );
  // The kernel's transport sources — the same set `install` / `run` use — so
  // `check` resolves every scheme they do, `oci://` included, direct-to-origin.
  // The browser-only `manifests.telo.sh` cache path stays the editor's; a CLI
  // resolves origin-direct so it never depends on the hub (federated-discovery
  // plan: resolution never routes through the hub).
  const loader = new Loader([
    new LocalFileSource(),
    ...recorders,
    ...defaultTransportRegistry(registryUrl).sources(),
  ]);
  return {
    loader,
    recorders,
    manifestsDirs: cacheTargets.map((t) => t.manifestsDir),
    verified: new Map(),
  };
}

/**
 * Drop a stale cache entry: the file, the loader's memo of it, and the record
 * that it was ever served. The next load re-resolves that one manifest through
 * the transports and leaves every other file's memo intact.
 *
 * Removal failures are warned, not thrown. This is cache maintenance, and the
 * rest of the command already treats caching as an optimization — a read-only
 * or root-owned `.telo` must not change the exit code of a static check. An
 * entry that could not be removed is still forgotten by the loader, so the
 * reload re-fetches it rather than trusting bytes it just judged stale.
 */
async function dropStaleEntry(
  file: string,
  session: CheckSession,
  log: Logger,
): Promise<void> {
  try {
    await fs.rm(file, { force: true });
  } catch (err) {
    outErrLine(
      `${log.err.warn(
        `[manifest-cache] could not remove stale entry ${file}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )}\n`,
    );
  }
  session.loader.forget(pathToFileURL(file).href);
  for (const recorder of session.recorders) {
    for (const [url, served] of recorder.served) {
      if (served === file) recorder.served.delete(url);
    }
  }
}

interface CheckOutcome {
  errorCount: number;
  warnCount: number;
  /** The same diagnostics the text form printed, as data for `-o json`. */
  diagnostics: JsonDiagnostic[];
  /** Non-empty when the load was served stale bytes; the caller drops these
   *  files and retries rather than reporting diagnostics derived from them. */
  staleFiles: string[];
  /** Digests observed while revalidating, carried to the retry so the repaired
   *  cache is recorded against what the registry actually serves now. */
  digests: Map<string, string>;
}

async function checkOne(
  inputPath: string,
  registryUrl: string,
  session: CheckSession,
  cacheTarget: CacheTarget | null,
  cacheWrite: boolean,
  /** Digests already verified by a prior pass. Present only on the retry after
   *  a stale entry was dropped: revalidating again would re-`HEAD` the same
   *  tags, and the freshly fetched bytes are current by construction. */
  knownDigests: Map<string, string> | null,
  log: Logger,
): Promise<CheckOutcome> {
  const entryPath = resolveEntryPath(inputPath);
  const isUrl = entryPath.startsWith("http://") || entryPath.startsWith("https://");

  try {
    // `desugarImports` so inline `imports:` maps expand into synthetic
    // Telo.Import manifests before analysis — `telo check` is a static
    // resolution consumer and must see inline imports exactly as the kernel does.
    const graph = await session.loader.loadGraph(entryPath, { desugarImports: true, migrate: true });

    // Freshness before analysis: a verdict computed from a moved tag would be
    // reported as authoritative. Pinned imports make this a no-op.
    let digests = knownDigests ?? new Map<string, string>();
    if (!knownDigests && session.recorders.length > 0) {
      const served = new Map<string, string>();
      for (const recorder of session.recorders) {
        for (const [url, file] of recorder.served) served.set(url, file);
      }
      const originsByRoot = new Map<string, Map<string, string>>();
      for (const dir of session.manifestsDirs) {
        originsByRoot.set(dir, await readOriginDigests(dir));
      }
      const freshness = await revalidateMutableOciRefs(
        graph,
        served,
        originsByRoot,
        registryUrl,
        session.verified,
      );
      if (freshness.staleFiles.length > 0) {
        return {
          errorCount: 0,
          warnCount: 0,
          diagnostics: [],
          staleFiles: freshness.staleFiles,
          digests: freshness.digests,
        };
      }
      digests = freshness.digests;
    }

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
      moduleDocuments: collectZoneModuleDocuments(graph),
      hostVersions: nodeHostVersions(),
    });
    const { diagnostics } = assembleGraphDiagnostics(graph, analysis);
    const counts = formatAnalysisDiagnostics(diagnostics, graph, log, entryPath);

    if (cacheWrite && cacheTarget) {
      // Write-through so the next check — and the next `telo run` from this
      // directory, which reads the same cache — is hermetic. Caching is an
      // optimization: a read-only filesystem warns rather than fails the check.
      try {
        await writeManifestCache(
          graph,
          cacheTarget.entryDir,
          registryUrl,
          cacheTarget.manifestsDir,
        );
        await writeOriginDigests(cacheTarget.manifestsDir, digests);
      } catch (err) {
        outErrLine(
          `${log.err.warn(`[manifest-cache] write failed: ${err instanceof Error ? err.message : String(err)}`)}\n`,
        );
      }
    }

    return { ...counts, staleFiles: [], digests };
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
      staleFiles: [],
      digests: new Map(),
    };
  }
}

export async function check(argv: {
  paths: string[];
  registryUrl?: string;
  cacheWrite?: boolean;
}): Promise<void> {
  const log = createLogger(false);

  // Same fallback chain as `run` / `install`.
  const registryUrl =
    argv.registryUrl ?? process.env.TELO_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  const cacheWrite = argv.cacheWrite !== false;

  const cacheTargets = new Map<string, CacheTarget>();
  for (const p of argv.paths) {
    const target = cacheTargetFor(resolveEntryPath(p));
    if (target) cacheTargets.set(target.manifestsDir, target);
  }

  const session = openSession([...cacheTargets.values()], registryUrl);

  let totalErrors = 0;
  let totalWarns = 0;
  const allDiagnostics: JsonDiagnostic[] = [];

  for (const p of argv.paths) {
    const cacheTarget = cacheTargetFor(resolveEntryPath(p));
    let outcome = await checkOne(p, registryUrl, session, cacheTarget, cacheWrite, null, log);

    if (outcome.staleFiles.length > 0) {
      // A mutable tag moved under the cache. Drop just those entries — file,
      // loader memo, and served record — so every other path's resolution
      // survives, then re-check. Revalidation is off on the retry: the digests
      // were established a moment ago, and the reload cannot be stale because
      // the entries it would have used are gone.
      for (const file of outcome.staleFiles) {
        await dropStaleEntry(file, session, log);
      }
      outcome = await checkOne(
        p,
        registryUrl,
        session,
        cacheTarget,
        cacheWrite,
        outcome.digests,
        log,
      );
    }

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

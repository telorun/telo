import {
  Kernel,
  LocalFileSource,
  LocalManifestCacheSource,
  resolveCacheRoot,
  resolveEntryDir,
  writeManifestCache,
  type RuntimeDiagnostic,
} from "@telorun/kernel";
import type { ManifestSource } from "@telorun/analyzer";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Argv } from "yargs";
import { createLogger, formatDiagnostics, type Logger } from "../logger.js";
import { attachControllerProgress } from "../controller-progress.js";

/**
 * Load .env and .env.local from the manifest's directory into process.env.
 * Priority (highest to lowest): process.env > .env.local > .env
 * Keys already present in process.env are never overwritten.
 */
function loadEnvFiles(manifestPath: string): void {
  const resolved = path.resolve(manifestPath);
  const dir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? resolved
    : path.dirname(resolved);
  const base = tryReadFile(path.join(dir, ".env"));
  const local = tryReadFile(path.join(dir, ".env.local"));

  const merged = { ...dotenv.parse(base), ...dotenv.parse(local) };
  for (const [key, value] of Object.entries(merged)) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

function tryReadFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

type WatchHandle = { cleanup: () => void };

/** The local manifest files a loaded graph was built from — entry, every
 *  `include:` partial, and every transitively-imported library + its partials.
 *  Remote (`http(s)://`) sources are skipped; only on-disk files are watchable.
 *  Empty until `load()` succeeds (the graph is dropped again on teardown), so
 *  callers must snapshot the set before `start()`. */
function collectWatchFiles(kernel: Kernel): Set<string> {
  const files = new Set<string>();
  const add = (source: string | undefined): void => {
    if (!source) return;
    if (source.startsWith("file://")) {
      files.add(fileURLToPath(source));
    } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
      // No URL scheme → an absolute local path (the loader's canonical form
      // for local files). A scheme like `https://` is remote, skip it.
      files.add(source);
    }
  };
  const graph = kernel.getLoadedGraph();
  if (graph) {
    for (const mod of graph.modules.values()) {
      add(mod.owner.source);
      for (const partial of mod.partials) add(partial.source);
    }
  }
  return files;
}

/** Best-effort entry file for the load-failed case, where no graph exists to
 *  enumerate. A directory entry resolves to its `telo.yaml`. */
function entryFilePath(manifestPath: string): string {
  const resolved = path.resolve(manifestPath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return path.join(resolved, "telo.yaml");
  }
  return resolved;
}

type WatcherSet = {
  /** Add a watcher for any path not already watched; returns the live count.
   *  Persistent across reload cycles — paths are never re-watched, because
   *  closing then re-`fs.watch`-ing the same path is silently dropped under
   *  bun (it never fires again), whereas one long-lived watcher fires on every
   *  change. So the set only ever grows as new files enter the graph. */
  sync: (files: Set<string>) => number;
};

/** One watcher set for the whole watch session. `onChange` is called, debounced
 *  per file, on every change to any watched path. */
function createWatcherSet(log: Logger, onChange: () => void): WatcherSet & WatchHandle {
  const watchers = new Map<string, fs.FSWatcher>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let active = true;

  function watchFile(fsPath: string): void {
    if (!active || watchers.has(fsPath)) return;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(fsPath, () => {
        if (!active) return;
        const existing = debounceTimers.get(fsPath);
        if (existing) clearTimeout(existing);
        debounceTimers.set(
          fsPath,
          setTimeout(() => {
            debounceTimers.delete(fsPath);
            if (!active) return;
            log.info(`[watch] change detected in ${fsPath}`);
            onChange();
          }, 150),
        );
      });
    } catch {
      return; // file may not exist yet
    }
    watcher.on("error", () => {
      // OS invalidated the watch (e.g. file deleted). Remove and re-establish.
      if (watchers.get(fsPath) === watcher) {
        watchers.delete(fsPath);
        setTimeout(() => {
          if (active) watchFile(fsPath);
        }, 50);
      }
    });
    watchers.set(fsPath, watcher);
  }

  return {
    sync(files: Set<string>): number {
      for (const f of files) watchFile(f);
      return watchers.size;
    },
    cleanup(): void {
      active = false;
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}

type RunArgv = {
  path: string;
  verbose: boolean;
  debug: boolean;
  snapshotOnExit: boolean;
  watch: boolean;
  /** `--no-cache-write`: read the baked cache but never persist derived entries. */
  cacheWrite: boolean;
  registryUrl?: string;
  "--"?: string[];
};

function registryUrlFor(argv: RunArgv): string {
  // The CLI owns the registry-URL fallback chain: --registry-url > TELO_REGISTRY_URL >
  // RegistrySource default. The kernel itself does no env lookup — programmatic
  // callers (tests, SDK) pass registryUrl explicitly when they need one.
  return argv.registryUrl ?? process.env.TELO_REGISTRY_URL ?? "https://registry.telo.run";
}

async function buildKernel(argv: RunArgv, log: Logger, cacheRoot: string | null): Promise<Kernel> {
  const registryUrl = argv.registryUrl ?? process.env.TELO_REGISTRY_URL;
  // The manifest cache (populated by `telo install`) wins over the registry
  // / HTTP sources so production images boot without any registry network
  // I/O. A missing cache file falls through transparently — dev runs and
  // ad-hoc invocations work unchanged.
  const sources: ManifestSource[] = [new LocalFileSource()];
  // `cacheRoot` is resolved once per invocation (honours TELO_CACHE_DIR) and
  // threaded here, to the kernel, and to persistManifestCache.
  if (cacheRoot) {
    // Pass the same registry URL the kernel will use so the cache source's
    // URL→path mapping matches what `telo install` wrote.
    sources.push(
      new LocalManifestCacheSource(
        resolveEntryDir(argv.path) ?? "",
        registryUrlFor(argv),
        path.join(cacheRoot, "manifests"),
      ),
    );
  }
  const kernel = new Kernel({ argv: argv["--"], registryUrl, sources });
  // Pretty controller-download progress. With --verbose, always render
  // (so captured logs/CI output get the lines too); otherwise gate on TTY
  // so CI and the docker service stay silent.
  attachControllerProgress(kernel, log, { force: argv.verbose });

  if (argv.debug) {
    const debugDir = path.join(process.cwd(), ".telo-debug");
    const eventStreamPath = path.join(debugDir, "events.jsonl");
    await kernel.enableEventStream(eventStreamPath);
    log.info(`Event stream enabled: ${eventStreamPath}`);
  }
  return kernel;
}

/**
 * Write-through to `<entry-dir>/.telo/manifests/` after a successful load. Same
 * persistence path as `telo install` — reuses `writeManifestCache` so cache
 * contents converge no matter which command populates them. Idempotent: a graph
 * whose files all came from `file://` sources (cache hit) results in no writes,
 * since `cachePathForCanonical` returns null for non-cacheable schemes. On
 * read-only filesystems (e.g. baked Docker images) we surface the error but do
 * not abort — caching is an optimization.
 */
async function persistManifestCache(
  argv: RunArgv,
  kernel: Kernel,
  log: Logger,
  cacheRoot: string | null,
): Promise<void> {
  // `--no-cache-write`: never write to the (read-only / baked) cache.
  if (!argv.cacheWrite) return;
  if (!cacheRoot) return;
  const graph = kernel.getLoadedGraph();
  if (!graph) return;
  try {
    await writeManifestCache(
      graph,
      resolveEntryDir(argv.path) ?? "",
      registryUrlFor(argv),
      path.join(cacheRoot, "manifests"),
    );
  } catch (err) {
    // Warnings belong on stderr — stdout is reserved for the manifest's own
    // output (consumers may pipe `telo run` into jq / a downstream process).
    process.stderr.write(
      `${log.warn(`[manifest-cache] write failed: ${err instanceof Error ? err.message : String(err)}`)}\n`,
    );
  }
}

/** Format an error as diagnostics on the terminal. Returns the non-warning
 *  count so the single-shot path can pick an exit code while watch keeps going. */
function reportError(argv: RunArgv, error: unknown, log: Logger): number {
  const isUrl = argv.path.startsWith("http://") || argv.path.startsWith("https://");
  const displayPath = isUrl
    ? argv.path
    : path.relative(process.cwd(), path.resolve(process.cwd(), argv.path));
  const attached = (error as any)?.diagnostics as RuntimeDiagnostic[] | undefined;
  const diags: RuntimeDiagnostic[] = attached?.length
    ? attached
    : [
        {
          message: error instanceof Error ? error.message : String(error),
          code: (error as any)?.code,
        },
      ];
  formatDiagnostics(diags, log, displayPath);
  const errorCount = diags.filter((d) => d.severity !== "warning").length;
  const warnCount = diags.filter((d) => d.severity === "warning").length;
  const parts: string[] = [];
  if (errorCount > 0) parts.push(log.error(`${errorCount} error${errorCount !== 1 ? "s" : ""}`));
  if (warnCount > 0) parts.push(log.warn(`${warnCount} warning${warnCount !== 1 ? "s" : ""}`));
  console.error(`\n${parts.join(", ")}`);
  return errorCount;
}

export async function run(argv: RunArgv): Promise<void> {
  const log = createLogger(argv.verbose);
  if (argv.watch) {
    await runWatch(argv, log);
    return;
  }

  // Resolve the `.telo` cache root once per invocation, then thread it.
  const cacheRoot = resolveCacheRoot(argv.path);

  try {
    const kernel = await buildKernel(argv, log, cacheRoot);
    const shutdown = () => {
      // Cooperatively cancel the boot run first (so honoring targets / in-flight
      // invoke trees stop early), then unblock the idle wait for graceful exit.
      kernel.cancel("interrupted");
      kernel.forceIdle();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    loadEnvFiles(argv.path);
    await kernel.load(argv.path, {
      cacheDir: cacheRoot,
      writeCache: argv.cacheWrite,
    });
    await persistManifestCache(argv, kernel, log, cacheRoot);

    await kernel.start();
    if (kernel.exitCode !== 0) {
      process.exit(kernel.exitCode);
    }
  } catch (error) {
    reportError(argv, error, log);
    process.exit(1);
  }
}

/**
 * Watch mode. The kernel has no incremental reload, so each cycle runs a fresh
 * kernel to completion-or-change: load → snapshot the graph's local files →
 * start (held alive so one-shot apps don't exit) → wait for a file change →
 * cancel + forceIdle to drive teardown → rebuild. A load/boot failure is
 * reported but does not exit; we keep watching so the next edit retries.
 */
async function runWatch(argv: RunArgv, log: Logger): Promise<void> {
  loadEnvFiles(argv.path);
  // Resolve the `.telo` cache root once per invocation, then thread it.
  const cacheRoot = resolveCacheRoot(argv.path);

  let stopping = false;
  let signalChange: (() => void) | null = null;
  let currentKernel: Kernel | null = null;

  // One watcher set for the whole session — see createWatcherSet. A change
  // resolves the current cycle's `changed` gate; cycles re-read `signalChange`
  // so the same watcher drives every reload.
  const watchers = createWatcherSet(log, () => signalChange?.());

  const requestStop = () => {
    stopping = true;
    log.info("\n[watch] stopping...");
    watchers.cleanup();
    currentKernel?.cancel("interrupted");
    currentKernel?.forceIdle();
    signalChange?.();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  // Watch the entry up-front so an edit during the first (possibly slow) load
  // still queues a reload; the graph's full file set is added after each load.
  watchers.sync(new Set([entryFilePath(argv.path)]));

  while (!stopping) {
    const kernel = await buildKernel(argv, log, cacheRoot);
    currentKernel = kernel;
    // Hold the kernel alive across the cycle so apps without their own hold
    // (e.g. script-only manifests) stay up until a change or Ctrl+C; forceIdle()
    // overrides every hold (including a server's own) when we want to reload.
    kernel.acquireHold("watch-mode");

    const changed = new Promise<void>((resolve) => {
      signalChange = resolve;
    });

    try {
      await kernel.load(argv.path, {
        cacheDir: cacheRoot,
        writeCache: argv.cacheWrite,
      });
      await persistManifestCache(argv, kernel, log, cacheRoot);
      const count = watchers.sync(collectWatchFiles(kernel));
      log.info(`[watch] watching ${count} file(s)`);

      // start() resolves on its own only on boot error or one-shot completion
      // without a hold; the hold keeps long-running and completed apps alive,
      // so the cycle advances on a file change. Errors are reported, not thrown.
      const startPromise = kernel.start().catch((err) => reportError(argv, err, log));
      await changed;
      kernel.cancel("reload");
      kernel.forceIdle();
      await startPromise;
    } catch (error) {
      // Load failed before start(); report and wait for an edit before retrying.
      reportError(argv, error, log);
      await kernel.teardown();
      await changed;
    }

    if (!stopping) log.info(log.ok("[watch] reloading..."));
  }
}

export function runCommand(yargs: Argv): Argv {
  return yargs.command(
    ["run <path> [..]", "$0 <path> [..]"],
    "Run a Telo runtime from a manifest file or directory",
    (y) =>
      y
        .positional("path", {
          describe: "Path to YAML manifest, directory containing telo.yaml, or HTTP(S) URL",
          type: "string",
          demandOption: true,
        })
        .option("registry-url", {
          type: "string",
          describe:
            "Base URL for the telo module registry. Overrides TELO_REGISTRY_URL.",
        })
        .strict(false),
    async (argv) => {
      // Everything after the manifest path that isn't a known telo flag
      // becomes argv for the kernel. We extract it from process.argv by
      // finding the manifest path and taking everything after it, excluding
      // known telo flags.
      const knownBooleanFlags = new Set([
        "--verbose", "--debug", "--snapshot-on-exit", "--watch", "-w",
        "--cache-write", "--no-cache-write",
        "--help", "--version",
      ]);
      const knownValuedFlags = new Set(["--registry-url"]);
      const rawArgs = process.argv;
      const pathIdx = rawArgs.indexOf(argv.path as string);
      const sliced = pathIdx >= 0 ? rawArgs.slice(pathIdx + 1) : [];
      const extraArgs: string[] = [];
      for (let i = 0; i < sliced.length; i++) {
        const a = sliced[i];
        if (a === "--") continue;
        if (knownBooleanFlags.has(a)) continue;
        const eqIdx = a.indexOf("=");
        const bare = eqIdx >= 0 ? a.slice(0, eqIdx) : a;
        if (knownValuedFlags.has(bare)) {
          // Only skip the next token as a value when it actually looks like one.
          // Guards against `--registry-url --verbose` (or trailing bare flag) where
          // yargs consumed `--verbose` as the value — we still want the next flag
          // re-evaluated by this loop rather than silently dropped.
          const next = sliced[i + 1];
          if (eqIdx < 0 && next !== undefined && !next.startsWith("-")) i++;
          continue;
        }
        extraArgs.push(a);
      }
      await run({ ...(argv as any), "--": extraArgs });
    },
  );
}

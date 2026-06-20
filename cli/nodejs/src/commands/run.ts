import type { ManifestSource } from "@telorun/analyzer";
import {
  Kernel,
  LocalFileSource,
  LocalManifestCacheSource,
  resolveCacheRoot,
  resolveEntryDir,
  writeManifestCache,
  type RuntimeDiagnostic,
} from "@telorun/kernel";
import type { RuntimeEvent } from "@telorun/sdk";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Argv } from "yargs";
import { extractModuleBundles } from "../bundle/extract.js";
import { attachControllerProgress } from "../controller-progress.js";
import { DebugEventSubscriber } from "../debug-event-subscriber.js";
import { serializeEvent, serializeLog } from "../debug-serialize.js";
import { DebugServer } from "../debug-server.js";
import { createLogger, formatDiagnostics, type Logger } from "../logger.js";
import { canOpenBrowser, openBrowser } from "../open-browser.js";
import { teeStdio } from "../stdio-tee.js";
import { resolveUiBundle } from "../ui-fetch.js";

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
  /** `--debug`: write the `.telo.debug.jsonl` event log. No network, no UI. */
  debug: boolean;
  /** `--inspect[=[host:]port]`: start the live inspection endpoint. `undefined`
   *  when the flag is absent; the (possibly empty) string value otherwise. */
  inspect?: string;
  /** `--no-open`: with `--inspect`, don't auto-open the UI in a browser. */
  open: boolean;
  snapshotOnExit: boolean;
  watch: boolean;
  /** `--no-cache-write`: read the baked cache but never persist derived entries. */
  cacheWrite: boolean;
  registryUrl?: string;
  "--"?: string[];
};

const DEFAULT_INSPECT_HOST = "127.0.0.1";
const DEFAULT_INSPECT_PORT = 9230;

/** Parse `--inspect`'s value: `""` → defaults, `"9300"` → port only,
 *  `"host:9300"` / `"[::1]:9300"` → both, `"host"` → host only. */
function parseInspectTarget(value: string): { host: string; port: number } {
  const v = value.trim();
  if (!v) return { host: DEFAULT_INSPECT_HOST, port: DEFAULT_INSPECT_PORT };
  const bracket = v.match(/^\[(.+)\]:(\d+)$/);
  if (bracket) return { host: bracket[1], port: Number(bracket[2]) };
  if (/^\d+$/.test(v)) return { host: DEFAULT_INSPECT_HOST, port: Number(v) };
  const idx = v.lastIndexOf(":");
  if (idx >= 0) {
    const portStr = v.slice(idx + 1);
    return {
      host: v.slice(0, idx) || DEFAULT_INSPECT_HOST,
      port: /^\d+$/.test(portStr) ? Number(portStr) : DEFAULT_INSPECT_PORT,
    };
  }
  return { host: v, port: DEFAULT_INSPECT_PORT };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function registryUrlFor(argv: RunArgv): string {
  // The CLI owns the registry-URL fallback chain: --registry-url > TELO_REGISTRY_URL >
  // RegistrySource default. The kernel itself does no env lookup — programmatic
  // callers (tests, SDK) pass registryUrl explicitly when they need one.
  return argv.registryUrl ?? process.env.TELO_REGISTRY_URL ?? "https://registry.telo.run";
}

/** An observability session composing two independent sinks: the `--debug` JSONL
 *  file and the `--inspect` live endpoint. Created once per CLI process; `attach`
 *  wires a (re)built kernel's `*` tap to whichever sinks are enabled, `stop` tears
 *  the endpoint down. Keeping one endpoint alive across watch reloads means the
 *  browser's SSE connection is never dropped — the new kernel's events flow into
 *  the stream the UI is already watching, instead of the UI seeing termination. */
type DebugSession = {
  attach: (kernel: Kernel) => void;
  /** Called once the kernel has loaded: publishes the app's resolved ports to the
   *  inspection endpoint and opens the UI the first time (deferred to here so the
   *  browser's discovery handshake already sees the endpoints). */
  markReady: (kernel: Kernel) => void;
  stop: () => void;
};

/**
 * Stand up the enabled sinks once per CLI process: `--debug` opens the JSONL file
 * sink; `--inspect` starts the live endpoint (loopback by default) and serves the
 * on-demand UI. The two compose — either, both, or (when neither flag is set) the
 * caller skips this entirely. A watch session re-attaches each rebuilt kernel via
 * {@link DebugSession.attach} rather than recreating sinks, so the endpoint's port
 * stays stable and the replay buffer + JSONL persist across reloads.
 */
async function startDebugSession(
  argv: RunArgv,
  log: Logger,
  cacheRoot: string | null,
): Promise<DebugSession> {
  let fileSink: DebugEventSubscriber | undefined;
  let eventLogPath: string | undefined;
  if (argv.debug) {
    // Stream next to the manifest by default (cwd fallback for URL entries).
    const debugDir = resolveEntryDir(argv.path) ?? process.cwd();
    eventLogPath = path.join(debugDir, ".telo.debug.jsonl");
    fileSink = new DebugEventSubscriber(eventLogPath);
    await fileSink.open();
    log.info(`Debug log: ${eventLogPath}`);
  }

  let server: DebugServer | undefined;
  if (argv.inspect !== undefined) {
    const { host, port } = parseInspectTarget(argv.inspect);
    if (!isLoopbackHost(host)) {
      log.info(
        log.warn(
          `[inspect] binding ${host}:${port} — the inspection endpoint streams event ` +
            `payloads (which can include secrets) to anyone who can reach this address.`,
        ),
      );
    }
    const ui = await resolveUiBundle(cacheRoot);
    if (ui.kind === "unavailable") {
      log.info(log.warn(`[inspect] debug UI unavailable — ${ui.reason}`));
    }
    server = new DebugServer({
      host,
      port,
      jsonlPath: eventLogPath,
      uiHtmlPath: ui.kind === "ok" ? ui.path : undefined,
      uiUnavailableReason: ui.kind === "unavailable" ? ui.reason : undefined,
    });
    await server.start();
    log.info(`Inspect:   ${server.url}`);
  }

  // Open the UI once (markReady), after the first load resolves the app's ports —
  // so the browser's discovery handshake already carries the app endpoints.
  // Reloads re-attach to the same endpoint, so no new tab. Skipped on CI/headless.
  let opened = false;
  const openUi = (): void => {
    if (opened || !server || !argv.open || !canOpenBrowser()) return;
    opened = true;
    openBrowser(server.url);
  };

  // Tee stdout/stderr into the same sinks so the stream carries the run's output
  // (`log` frames) alongside kernel events. The terminal is untouched. Installed
  // once per process; restored on stop so the wrapping never outlives the session.
  const stopTee = teeStdio((stream, line) => {
    const wireLine = serializeLog(stream, line);
    void fileSink?.write(wireLine);
    server?.push(wireLine);
  });

  return {
    attach(kernel: Kernel): void {
      // A consumer is attached → turn on invocation tracing so events carry
      // `invocationId` / `parentInvocationId` and the UI can rebuild call trees.
      kernel.setTracing(true);
      // One `*` tap, serialized once, fanned to whichever sinks are enabled. The
      // kernel knows nothing of debug/inspect — it's a plain event listener.
      kernel.on("*", (event: RuntimeEvent) => {
        const line = serializeEvent(event.name, event.payload, event.metadata, server?.blobStore);
        void fileSink?.write(line);
        server?.push(line);
      });
    },
    markReady(kernel: Kernel): void {
      server?.setEndpoints(
        kernel.getResolvedPorts().map(({ port, protocol }) => ({ host: "", port, protocol })),
      );
      openUi();
    },
    stop(): void {
      stopTee();
      server?.stop();
    },
  };
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
    const entryDir = resolveEntryDir(argv.path) ?? "";
    const manifestsDir = path.join(cacheRoot, "manifests");
    await writeManifestCache(graph, entryDir, registryUrlFor(argv), manifestsDir);
    await extractModuleBundles(graph, entryDir, registryUrlFor(argv), manifestsDir, (msg) =>
      process.stderr.write(`${log.warn(`[manifest-cache] ${msg}`)}\n`),
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
  const debug =
    argv.debug || argv.inspect !== undefined
      ? await startDebugSession(argv, log, cacheRoot)
      : undefined;

  try {
    const kernel = await buildKernel(argv, log, cacheRoot);
    debug?.attach(kernel);
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
    debug?.markReady(kernel);

    // `--inspect` launches an inspector to look at the running app, so hold it
    // open even after a one-shot app goes idle — otherwise it exits before it can
    // be inspected. The kernel hold keeps `start()` from resolving, but a pending
    // `waitForIdle()` promise doesn't keep the event loop alive and the inspect
    // server unrefs its socket — so ref a timer to keep the process up. SIGINT's
    // `forceIdle()` resolves `start()`, then we clear the timer for a clean exit.
    // (`--debug` is a fire-and-forget log; it keeps exiting on idle as before.)
    let inspectKeepAlive: ReturnType<typeof setInterval> | undefined;
    if (argv.inspect !== undefined) {
      kernel.acquireHold("inspect");
      inspectKeepAlive = setInterval(() => {}, 2 ** 30);
      log.info("[inspect] holding the application open — press Ctrl+C to exit");
    }

    try {
      await kernel.start();
    } finally {
      if (inspectKeepAlive) clearInterval(inspectKeepAlive);
    }
    // start() resolves once the app is idle/torn down (incl. via the SIGINT
    // handler's forceIdle). Stop the debug server so its SSE sockets + heartbeats
    // don't keep the process alive past here.
    debug?.stop();
    if (kernel.exitCode !== 0) {
      process.exit(kernel.exitCode);
    }
  } catch (error) {
    debug?.stop();
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
  // One inspect endpoint for the whole watch session — reloads re-attach the
  // rebuilt kernel to it (see startDebugSession), so the UI connection survives.
  const debug =
    argv.debug || argv.inspect !== undefined
      ? await startDebugSession(argv, log, cacheRoot)
      : undefined;

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
    debug?.stop();
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
    debug?.attach(kernel);
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
      debug?.markReady(kernel);
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
        .option("debug", {
          type: "boolean",
          describe: "Write a .telo.debug.jsonl event log next to the manifest.",
        })
        .option("inspect", {
          type: "string",
          describe:
            "Start the live inspection endpoint. Optional [host:]port (default 127.0.0.1:9230).",
        })
        .option("open", {
          type: "boolean",
          default: true,
          describe: "With --inspect, auto-open the UI in a browser. Use --no-open to suppress.",
        })
        .strict(false),
    async (argv) => {
      // Everything after the manifest path that isn't a known telo flag
      // becomes argv for the kernel. We extract it from process.argv by
      // finding the manifest path and taking everything after it, excluding
      // known telo flags.
      const knownBooleanFlags = new Set([
        "--verbose", "--debug", "--snapshot-on-exit", "--watch", "-w",
        "--cache-write", "--no-cache-write", "--open", "--no-open",
        "--help", "--version",
      ]);
      // `--inspect` is valued ([host:]port). The valued-flag branch below skips
      // the `=` form and the space form alike, so neither leaks into kernel argv.
      const knownValuedFlags = new Set(["--registry-url", "--inspect"]);
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

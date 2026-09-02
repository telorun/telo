import type { LoadedModule, ManifestSource } from "@telorun/analyzer";
import {
  Kernel,
  LocalFileSource,
  DebugWireSink,
  LocalManifestCacheSource,
  resolveCacheRoot,
  resolveEntryDir,
  writeManifestCache,
  lastBuildInputs,
  type RuntimeDiagnostic,
} from "@telorun/kernel";
import { SEVERITY, type RuntimeEvent } from "@telorun/sdk";
import { PackageURL } from "packageurl-js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Argv } from "yargs";
import { attachControllerProgress } from "../controller-progress.js";
import { DebugEventSubscriber } from "../debug-event-subscriber.js";
import { serializeEvent, serializeLog } from "../debug-serialize.js";
import { DebugServer } from "../debug-server.js";
import { resolveEnvFiles } from "../env-files.js";
import { createLogger, formatDiagnostics, type Logger } from "../logger.js";
import { outErrLine, output } from "../output.js";
import { canOpenBrowser, openBrowser } from "../open-browser.js";
import { teeStdio } from "../stdio-tee.js";
import { resolveUiBundle } from "../ui-fetch.js";

/**
 * Apply the env files visible to the manifest, then report.
 *
 * The walk itself is `env-files.ts`'s; what belongs here is the two decisions a
 * command makes about it — that these values go into `process.env` without
 * displacing anything the real environment already carries, and that the file
 * list is `--debug` detail while a file that could not be READ is never quiet,
 * whatever the flags say.
 */
function applyEnvFiles(manifestPath: string, report: boolean): void {
  const { values, loaded, unreadable } = resolveEnvFiles(manifestPath);
  for (const [key, value] of Object.entries(values)) {
    if (!(key in process.env)) process.env[key] = value;
  }
  for (const file of unreadable) {
    outErrLine(`[env] could not read ${file.path} (${file.reason}) — its values were not applied`);
  }
  if (report && loaded.length > 0) {
    outErrLine(`[env] loaded ${loaded.join(", ")}`);
  }
}

type WatchHandle = { cleanup: () => void };

/** An on-disk path for a loader source URL, or `null` when the source is remote
 *  and therefore not watchable. */
function localPathOf(source: string | undefined): string | null {
  if (!source) return null;
  if (source.startsWith("file://")) return fileURLToPath(source);
  // No URL scheme → an absolute local path (the loader's canonical form for
  // local files). A scheme like `https://` is remote.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? null : source;
}

/** The local manifest files a loaded graph was built from — entry, every
 *  `include:` partial, and every transitively-imported library + its partials —
 *  plus each local module's controller sources. Remote (`http(s)://`) sources are
 *  skipped; only on-disk files are watchable. Empty until `load()` succeeds (the
 *  graph is dropped again on teardown), so callers must snapshot the set before
 *  `start()`.
 *
 *  Controller sources are in the set because a local module's controller is now
 *  built from them: an edit under `src/` changes what the next run loads exactly
 *  as an edit to `telo.yaml` does, so it has to trigger the same restart. */
async function collectWatchFiles(kernel: Kernel): Promise<Set<string>> {
  const files = new Set<string>();
  const add = (source: string | undefined): void => {
    const local = localPathOf(source);
    if (local) files.add(local);
  };
  const graph = kernel.getLoadedGraph();
  if (graph) {
    for (const mod of graph.modules.values()) {
      add(mod.owner.source);
      for (const partial of mod.partials) add(partial.source);
      await addControllerSources(mod, kernel.getCacheRoot(), files);
    }
  }
  return files;
}

/** Every `local_path` a module's `Telo.Definition` docs declare, read from the
 *  manifests the loader already parsed rather than re-scanned out of the text —
 *  a PURL wrapped across lines is invisible to a line regex, and watch mode would
 *  silently stop reacting to controller edits with no diagnostic. */
function controllerSources(mod: LoadedModule): string[] {
  const moduleDir = path.dirname(localPathOf(mod.owner.source) ?? "");
  if (moduleDir === "") return [];
  const sources: string[] = [];
  for (const file of [mod.owner, ...mod.partials]) {
    for (const manifest of file.manifests) {
      const candidates = (manifest as { controllers?: unknown } | null)?.controllers;
      if (!Array.isArray(candidates)) continue;
      for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        let parsed: PackageURL;
        try {
          parsed = PackageURL.fromString(candidate);
        } catch {
          continue; // the analyzer and the loader both report a bad PURL better
        }
        const localPath = parsed.qualifiers?.local_path;
        if (parsed.type !== "telo" || !localPath) continue;
        sources.push(path.resolve(moduleDir, localPath));
      }
    }
  }
  return sources;
}

/**
 * Watch what a controller is actually built from.
 *
 * The exact set is esbuild's own input list, which `source-bundle-builder`
 * persists per entry point when it builds — so it covers the module's sources,
 * the shared TS libraries it inlines, and its dependency tree. Deriving it from
 * the entry point's directory instead would be wrong in both directions: it
 * would miss a shared library one directory over, and sweep in `dist/` and the
 * emitted `.mjs` beside it.
 *
 * Before the first build there is no index yet, so the entry point alone stands
 * in — enough to notice the edit that triggers that first build.
 */
async function addControllerSources(
  mod: LoadedModule,
  cacheRoot: string | undefined,
  files: Set<string>,
): Promise<void> {
  for (const entry of controllerSources(mod)) {
    files.add(entry);
    if (!cacheRoot) continue;
    for (const input of await lastBuildInputs(entry, cacheRoot)) files.add(input);
  }
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
   *  Persistent across reload cycles — the set only ever grows as new files
   *  enter the graph. A path is re-watched only when the file behind it is
   *  replaced (see `rebindIfReplaced`). */
  sync: (files: Set<string>) => number;
};

/** One watcher set for the whole watch session. `onChange` is called, debounced
 *  per file, on every change to any watched path. */
function createWatcherSet(log: Logger, onChange: () => void): WatcherSet & WatchHandle {
  /** A watcher plus the inode it is bound to — `fs.watch` follows the inode, not
   *  the path, so the pair is what lets us notice the file being swapped out. */
  type Watched = { watcher: fs.FSWatcher; inode: bigint | null };

  const watchers = new Map<string, Watched>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let active = true;

  function inodeOf(fsPath: string): bigint | null {
    try {
      return fs.statSync(fsPath, { bigint: true }).ino;
    } catch {
      return null;
    }
  }

  /** An editor's atomic save (write a temp file, then rename it over the path)
   *  puts a NEW inode behind the path. The watcher stays bound to the replaced
   *  one, so it never fires again — and emits no `error`, so the handler below
   *  never runs and `sync` skips the path as already watched. The event we are
   *  handling is that watcher's last gasp, so rebind on it. Keyed on the inode
   *  rather than on a `rename` event type, which bun does not deliver. */
  function rebindIfReplaced(fsPath: string): void {
    const entry = watchers.get(fsPath);
    if (!entry) return;
    const inode = inodeOf(fsPath);
    if (inode === null || inode === entry.inode) return;
    entry.watcher.close();
    watchers.delete(fsPath);
    watchFile(fsPath);
  }

  function watchFile(fsPath: string): void {
    if (!active || watchers.has(fsPath)) return;
    const inode = inodeOf(fsPath);
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(fsPath, () => {
        if (!active) return;
        rebindIfReplaced(fsPath);
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
      if (watchers.get(fsPath)?.watcher === watcher) {
        watchers.delete(fsPath);
        setTimeout(() => {
          if (active) watchFile(fsPath);
        }, 50);
      }
    });
    watchers.set(fsPath, { watcher, inode });
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
      for (const { watcher } of watchers.values()) watcher.close();
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

/** An observability session composing two independent sinks: the `--debug` JSONL
 *  file and the `--inspect` live endpoint. Created once per CLI process; `attach`
 *  wires a (re)built kernel's `*` tap to whichever sinks are enabled, `stop` tears
 *  the endpoint down. Keeping one endpoint alive across watch reloads means the
 *  browser's SSE connection is never dropped — the new kernel's events flow into
 *  the stream the UI is already watching, instead of the UI seeing termination. */
type DebugSession = {
  attach: (kernel: Kernel) => void;
  /** Push an event the kernel itself cannot emit, onto the same sinks a kernel
   *  event travels. Exists for exactly one case — see {@link emitRunFailed}. */
  emitEvent: (name: string, payload: unknown) => void;
  /** Called once the kernel has loaded: publishes the app's resolved ports to the
   *  inspection endpoint and opens the UI the first time (deferred to here so the
   *  browser's discovery handshake already sees the endpoints). */
  markReady: (kernel: Kernel) => void;
  /** `kernel` detaches the debug-wire log sink, which recomputes the
   *  minimum-level gate (§12.1). Omitted when no kernel is live yet. */
  stop: (kernel?: Kernel) => void;
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
    const ui = await resolveUiBundle(cacheRoot, argv.cacheWrite);
    if (ui.kind === "unavailable") {
      log.info(log.warn(`[inspect] debug UI unavailable — ${ui.reason}`));
    }
    server = new DebugServer({
      host,
      port,
      jsonlPath: eventLogPath,
      uiHtmlPath: ui.kind === "ok" ? ui.path : undefined,
      uiHtml: ui.kind === "inline" ? ui.html : undefined,
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

  let attachedRecordSink: DebugWireSink | undefined;

  /** Push an event onto the same sinks a kernel event travels. Shared by the
   *  two callers below rather than reached through `this`, which inside an
   *  object literal is not the returned session. */
  const pushEvent = (name: string, payload: unknown): void => {
    const line = serializeEvent(name, payload, undefined, server?.blobStore);
    void fileSink?.write(line);
    server?.push(line);
  };

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
      // The debug wire is one log sink among others, not the logging pipeline
      // (D1): logging works with no consumer attached and with tracing off. It
      // is attached here rather than declared in the manifest because it is
      // tooling attachment, not application configuration (§12.1).
      attachedRecordSink = new DebugWireSink({
        level: SEVERITY.trace,
        emit: (frame) => {
          const line = `${JSON.stringify(frame)}\n`;
          void fileSink?.write(line);
          server?.push(line);
        },
      });
      kernel.logging.pipeline.attach(attachedRecordSink);
    },
    emitEvent: pushEvent,
    markReady(kernel: Kernel): void {
      const ports = kernel.getResolvedPorts();
      server?.setEndpoints(ports.map(({ port, protocol }) => ({ host: "", port, protocol })));
      // The same fact the handshake above carries, put on the STREAM — a host
      // that routes to this app (a runner standing up a Service and an Ingress)
      // holds a stream and would otherwise have to poll for it, or re-parse the
      // manifest to learn a `ports:` edit landed. Re-emitted per reload, because
      // `markReady` runs once per watch cycle and resolution re-happens.
      pushEvent("Kernel.PortsResolved", { ports: [...ports] });
      openUi();
    },
    stop(kernel?: Kernel): void {
      // Detaching changes the minimum-level gate, so the pipeline recomputes it
      // and propagates the new threshold (§12.1).
      if (attachedRecordSink && kernel) {
        kernel.logging.pipeline.detach(attachedRecordSink);
        attachedRecordSink = undefined;
      }
      stopTee();
      server?.stop();
    },
  };
}

async function buildKernel(argv: RunArgv, log: Logger, cacheRoot: string | null): Promise<Kernel> {
  // The manifest cache (populated by `telo install`) wins over the network
  // sources so production images boot without any network I/O. A missing cache
  // file falls through transparently — dev runs and ad-hoc invocations work
  // unchanged.
  const sources: ManifestSource[] = [new LocalFileSource()];
  // `cacheRoot` is resolved once per invocation (honours TELO_CACHE_DIR) and
  // threaded here, to the kernel, and to persistManifestCache.
  if (cacheRoot) {
    sources.push(
      new LocalManifestCacheSource(
        resolveEntryDir(argv.path) ?? "",
        path.join(cacheRoot, "manifests"),
      ),
    );
  }
  const kernel = new Kernel({ argv: argv["--"], sources });
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
    await writeManifestCache(graph, entryDir, manifestsDir);
  } catch (err) {
    // Warnings belong on stderr — stdout is reserved for the manifest's own
    // output (consumers may pipe `telo run` into jq / a downstream process).
    outErrLine(
      log.err.warn(
        `[manifest-cache] write failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}

/** Count the errors a reader actually has to act on: entries the kernel marked
 *  `derived` are shadows of another failure, and an entry that only wraps a
 *  nested context (an import) counts as whatever failed inside it. Never
 *  reports zero for a real failure — a wrapper whose children are all derived
 *  still counts as one. */
function countRootErrors(diagnostics: RuntimeDiagnostic[]): number {
  let count = 0;
  for (const d of diagnostics) {
    if (d.severity === "warning") continue;
    const fromChildren = d.children?.length ? countRootErrors(d.children) : 0;
    // A collapsed entry contributes nothing itself, but a nested context it
    // wraps still carries its own root causes.
    if (d.derived) count += fromChildren;
    else count += fromChildren || 1;
  }
  return count;
}

/** Format an error as diagnostics on the terminal. Returns the non-warning
 *  count so the single-shot path can pick an exit code while watch keeps going.
 *  The kernel's loaded graph is what turns a static failure's `origin` into a
 *  `file:line:col` — it is present for every failure raised after the graph
 *  loaded, which is every static one. */
function reportError(argv: RunArgv, error: unknown, log: Logger, kernel?: Kernel): number {
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
  formatDiagnostics(diags, log, displayPath, kernel?.getLoadedGraph());
  const errorCount = countRootErrors(diags);
  const warnCount = diags.filter((d) => d.severity === "warning").length;
  const out = output();
  const parts: string[] = [];
  if (errorCount > 0)
    parts.push(log.err.error(`${errorCount} error${errorCount !== 1 ? "s" : ""}`));
  if (warnCount > 0) parts.push(log.err.warn(`${warnCount} warning${warnCount !== 1 ? "s" : ""}`));
  out.errLine(`\n${parts.join(", ")}`);
  // No envelope, deliberately: `run` is exempt from `-o json`.
  //
  // The kernel runs in-process, and `teeStdio` COPIES the app's stdout/stderr
  // rather than redirecting them — so the app writes to these same two
  // descriptors. An envelope appended after arbitrary app output is unparseable
  // on either stream, which is the exact failure `-o json` exists to remove, and
  // there is no third descriptor to claim. The machine surface for a run is
  // `--debug`, whose wire protocol is framed per event precisely because it
  // shares a stream with the app.
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

  // Held outside the try so the catch can reach the loaded graph a static
  // failure's location resolves against.
  let bootedKernel: Kernel | undefined;
  let loaded = false;
  try {
    const kernel = await buildKernel(argv, log, cacheRoot);
    bootedKernel = kernel;
    debug?.attach(kernel);
    const shutdown = () => {
      // Cooperatively cancel the boot run first (so honoring targets / in-flight
      // invoke trees stop early), then unblock the idle wait for graceful exit.
      kernel.cancel("interrupted");
      kernel.forceIdle();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    applyEnvFiles(argv.path, argv.debug);
    await kernel.load(argv.path, {
      cacheDir: cacheRoot,
      writeCache: argv.cacheWrite,
    });
    loaded = true;
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
    debug?.stop(kernel);
    if (kernel.exitCode !== 0) {
      process.exit(kernel.exitCode);
    }
  } catch (error) {
    // Emitted BEFORE the sinks are torn down, or the one frame naming the cause
    // never reaches a consumer.
    emitRunFailed(debug, loaded ? "start" : "load", error);
    debug?.stop();
    reportError(argv, error, log, bootedKernel);
    process.exit(1);
  }
}

/**
 * The one thing a watching consumer cannot otherwise learn: that this generation
 * never reached a running state, and why. `Kernel.Starting` / `Kernel.Started` /
 * `Kernel.Stopped` describe a run that got as far as starting; a manifest that
 * fails to LOAD emits none of them, and a boot failure emits `Starting` and then
 * nothing — so a consumer projecting run outcomes would show either silence or a
 * generation stuck at `started` forever, with the reason only on the terminal.
 *
 * One event name for both, carrying `phase`, because a consumer projects them to
 * the same outcome and a second name would split one outcome in two. A dotted
 * event name obliges no other runtime — the vocabulary inside an event frame is
 * already open, where the frame-kind set is the conformance contract every kernel
 * must implement.
 */
function emitRunFailed(
  debug: DebugSession | undefined,
  phase: "load" | "start",
  error: unknown,
): void {
  if (!debug) return;
  const diagnostics = (error as { diagnostics?: RuntimeDiagnostic[] })?.diagnostics;
  const code = (error as { code?: string })?.code ?? diagnostics?.find((d) => d.code)?.code;
  debug.emitEvent("Kernel.RunFailed", {
    phase,
    ...(code ? { code } : {}),
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Watch mode. The kernel has no incremental reload, so each cycle runs a fresh
 * kernel to completion-or-change: load → snapshot the graph's local files →
 * start (held alive so one-shot apps don't exit) → wait for a file change →
 * cancel + forceIdle to drive teardown → rebuild. A load/boot failure is
 * reported but does not exit; we keep watching so the next edit retries.
 */
async function runWatch(argv: RunArgv, log: Logger): Promise<void> {
  applyEnvFiles(argv.path, argv.debug);
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
  /** A change that arrived while no cycle was waiting on a gate — teardown and
   *  the next load take seconds, and resolving an already-settled promise is a
   *  no-op, so the edit would be lost. The next cycle consumes it instead. */
  let pendingChange = false;

  // One watcher set for the whole session — see createWatcherSet. A change
  // resolves the current cycle's `changed` gate; cycles re-read `signalChange`
  // so the same watcher drives every reload.
  const notifyChange = () => {
    if (signalChange) signalChange();
    else pendingChange = true;
  };
  const watchers = createWatcherSet(log, notifyChange);

  const requestStop = () => {
    stopping = true;
    log.info("\n[watch] stopping...");
    watchers.cleanup();
    debug?.stop(currentKernel ?? undefined);
    currentKernel?.cancel("interrupted");
    currentKernel?.forceIdle();
    notifyChange();
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
      // Clearing the slot on resolve is what routes a later change into
      // `pendingChange` instead of onto this already-settled gate.
      signalChange = () => {
        signalChange = null;
        resolve();
      };
    });
    if (pendingChange) {
      pendingChange = false;
      notifyChange();
    }

    try {
      await kernel.load(argv.path, {
        cacheDir: cacheRoot,
        writeCache: argv.cacheWrite,
      });
      await persistManifestCache(argv, kernel, log, cacheRoot);
      debug?.markReady(kernel);
      const count = watchers.sync(await collectWatchFiles(kernel));
      log.info(`[watch] watching ${count} file(s)`);

      // start() resolves on its own only on boot error or one-shot completion
      // without a hold; the hold keeps long-running and completed apps alive,
      // so the cycle advances on a file change. Errors are reported, not thrown.
      const startPromise = kernel.start().catch((err) => {
        emitRunFailed(debug, "start", err);
        return reportError(argv, err, log, kernel);
      });
      await changed;
      kernel.cancel("reload");
      kernel.forceIdle();
      await startPromise;
    } catch (error) {
      // Load failed before start(); report and wait for an edit before retrying.
      emitRunFailed(debug, "load", error);
      reportError(argv, error, log, kernel);
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
      const knownValuedFlags = new Set(["--inspect"]);
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
          // Guards against `--inspect --verbose` (or trailing bare flag) where
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

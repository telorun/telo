import { Kernel, LocalFileSource, type RuntimeDiagnostic } from "@telorun/kernel";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Argv } from "yargs";
import { createLogger, formatDiagnostics, type Logger } from "../logger.js";

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

function setupWatchMode(kernel: Kernel, log: Logger): WatchHandle {
  const watchers = new Map<string, fs.FSWatcher>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reloading = new Set<string>();
  let active = true;

  function watchFile(filePath: string): void {
    if (!active || watchers.has(filePath)) return;
    // getSourceFiles() returns file:// URLs; fs.watch needs a filesystem path
    const fsPath = filePath.startsWith("file://") ? fileURLToPath(filePath) : filePath;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(fsPath, () => {
        if (!active) return;
        const existing = debounceTimers.get(filePath);
        if (existing) clearTimeout(existing);
        debounceTimers.set(
          filePath,
          setTimeout(() => {
            debounceTimers.delete(filePath);
            void handleChange(filePath);
          }, 150),
        );
      });
    } catch {
      return; // file may not exist yet
    }
    watcher.on("error", () => {
      // OS invalidated the watch (e.g. file deleted). Remove and re-establish.
      if (watchers.get(filePath) === watcher) {
        watchers.delete(filePath);
        setTimeout(() => {
          if (active) watchFile(filePath);
        }, 50);
      }
    });
    watchers.set(filePath, watcher);
  }

  async function handleChange(filePath: string): Promise<void> {
    // Prevent concurrent reloads for the same file
    if (reloading.has(filePath)) return;
    reloading.add(filePath);
    log.info(`[watch] reloading ${filePath}`);
    try {
      // await kernel.reloadSource(filePath);
      // Watch any new files that appeared after reload
      // for (const f of kernel.getSourceFiles()) watchFile(f);
      log.info(log.ok(`[watch] complete`));
    } catch (err) {
      log.info(log.error(`[watch] error: ${err instanceof Error ? err.message : String(err)}`));
    } finally {
      reloading.delete(filePath);
    }
  }

  function cleanup(): void {
    active = false;
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    for (const w of watchers.values()) w.close();
    watchers.clear();
  }

  // for (const f of kernel.getSourceFiles()) watchFile(f);
  return { cleanup };
}

export async function run(argv: {
  path: string;
  verbose: boolean;
  debug: boolean;
  snapshotOnExit: boolean;
  watch: boolean;
  registryUrl?: string;
  "--"?: string[];
}): Promise<void> {
  const log = createLogger(argv.verbose);

  try {
    // The CLI owns the registry-URL fallback chain: --registry-url > TELO_REGISTRY_URL >
    // RegistrySource default. The kernel itself does no env lookup — programmatic
    // callers (tests, SDK) pass registryUrl explicitly when they need one.
    const registryUrl = argv.registryUrl ?? process.env.TELO_REGISTRY_URL;
    const kernel = new Kernel({
      argv: argv["--"],
      registryUrl,
      sources: [new LocalFileSource()],
    });
    if (argv.verbose) {
      kernel.on("*", (event: any) => {
        log.info(`${event.name}: ${JSON.stringify(event.payload)}`);
      });
    }

    if (argv.debug) {
      const debugDir = path.join(process.cwd(), ".telo-debug");
      const eventStreamPath = path.join(debugDir, "events.jsonl");
      await kernel.enableEventStream(eventStreamPath);
      log.info(`Event stream enabled: ${eventStreamPath}`);
    }

    let watchHandle: WatchHandle | null = null;

    const shutdown = () => {
      if (argv.watch) log.info("\n[watch] stopping...");
      watchHandle?.cleanup();
      kernel.shutdown();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    if (argv.watch) {
      // Acquire a hold BEFORE start() to keep the kernel alive for apps that
      // don't have their own holds (e.g. script-only manifests).
      // shutdown() will force-resolve waitForIdle() on Ctrl+C regardless of
      // how many holds are active (e.g. Http.Server may hold its own).
      kernel.acquireHold("watch-mode");

      kernel.on("Kernel.Started", () => {
        // const files = kernel.getSourceFiles();
        // log.info(`[watch] watching ${files.length} file(s)`);
        watchHandle = setupWatchMode(kernel, log);
      });
    }

    loadEnvFiles(argv.path);
    await kernel.load(argv.path);

    await kernel.start();
    if (kernel.exitCode !== 0) {
      process.exit(kernel.exitCode);
    }
  } catch (error) {
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
    process.exit(1);
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

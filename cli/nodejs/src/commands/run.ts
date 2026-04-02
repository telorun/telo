import { Kernel, type RuntimeDiagnostic } from "@telorun/kernel";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Argv } from "yargs";
import { createLogger, formatDiagnostics, type Logger } from "../logger.js";

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
}): Promise<void> {
  const log = createLogger(argv.verbose);

  try {
    const kernel = new Kernel();
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

    await kernel.loadFromConfig(argv.path);

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
      : [{ message: error instanceof Error ? error.message : String(error), code: (error as any)?.code }];
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
    ["run <path>", "$0 <path>"],
    "Run a Telo runtime from a manifest file or directory",
    (y) =>
      y.positional("path", {
        describe: "Path to YAML manifest, directory containing module.yaml, or HTTP(S) URL",
        type: "string",
        demandOption: true,
      }),
    async (argv) => {
      await run(argv as any);
    },
  );
}

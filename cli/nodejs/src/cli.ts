#!/usr/bin/env node

import { Kernel } from "@telorun/kernel";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

function createLogger(verbose: boolean) {
  const useColor = process.stdout.isTTY;
  const wrap = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    info: (...args: any[]) => console.log(...args),
    ok: (text: string) => wrap("32", text),
    warn: (text: string) => wrap("33", text),
    error: (text: string) => wrap("31", text),
    dim: (text: string) => wrap("2", text),
    verbose,
  };
}

type WatchHandle = { cleanup: () => void };

function setupWatchMode(kernel: Kernel, log: ReturnType<typeof createLogger>): WatchHandle {
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

async function run(argv: {
  path: string;
  verbose: boolean;
  debug: boolean;
  snapshotOnExit: boolean;
  watch: boolean;
}) {
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

      const shutdown = () => {
        log.info("\n[watch] stopping...");
        watchHandle?.cleanup();
        kernel.shutdown();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    }

    await kernel.loadFromConfig(argv.path);

    await kernel.start();
    if (kernel.exitCode !== 0) {
      process.exit(kernel.exitCode);
    }
  } catch (error) {
    console.error(
      "Error loading runtime:",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exit(1);
  }
}

yargs(hideBin(process.argv))
  .scriptName("telo")
  .usage("$0 <command> [options]")
  .command(
    ["run <path>", "$0 <path>"],
    "Run a Telo runtime from a manifest file or directory",
    (yargs) =>
      yargs.positional("path", {
        describe: "Path to YAML manifest, directory containing module.yaml, or HTTP(S) URL",
        type: "string",
        demandOption: true,
      }),
    async (argv) => {
      await run(argv as any);
    },
  )
  .option("verbose", {
    type: "boolean",
    default: false,
    describe: "Enable verbose logging",
  })
  .option("debug", {
    type: "boolean",
    default: false,
    describe: "Enable debug event streaming",
  })
  .option("snapshot-on-exit", {
    type: "boolean",
    default: false,
    describe: "Capture a snapshot on exit",
  })
  .option("watch", {
    alias: "w",
    type: "boolean",
    default: false,
    describe: "Watch manifest files and reload on change",
  })
  .demandCommand(1, "Please specify a command or path to run")
  .strict()
  .help()
  .version()
  .parse();

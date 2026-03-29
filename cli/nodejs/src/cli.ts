#!/usr/bin/env node

import type { PositionIndex } from "@telorun/analyzer";
import { DiagnosticSeverity, Loader, NodeAdapter, StaticAnalyzer } from "@telorun/analyzer";
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

async function checkOne(
  inputPath: string,
  log: ReturnType<typeof createLogger>,
): Promise<{ errorCount: number; warnCount: number }> {
  const isUrl = inputPath.startsWith("http://") || inputPath.startsWith("https://");
  const entryPath = isUrl ? inputPath : path.resolve(process.cwd(), inputPath);
  const cwd = isUrl ? process.cwd() : path.dirname(entryPath);

  const loader = new Loader([new NodeAdapter(cwd)]);

  let manifests;
  try {
    manifests = await loader.loadManifests(entryPath);
  } catch (err) {
    const sourceLine = (err as any).sourceLine as number | undefined;
    const displayPath = isUrl ? entryPath : path.relative(process.cwd(), entryPath);
    const loc = sourceLine !== undefined ? `:${sourceLine + 1}` : "";
    console.error(
      `${displayPath}${loc}  ${log.error("error")}  ${err instanceof Error ? err.message : String(err)}`,
    );
    return { errorCount: 1, warnCount: 0 };
  }

  const diagnostics = new StaticAnalyzer().analyze(manifests);

  const manifestByKey = new Map<string, (typeof manifests)[number]>();
  for (const m of manifests) {
    if (m.kind && m.metadata?.name) {
      manifestByKey.set(`${m.kind}.${m.metadata.name}`, m);
    }
  }

  let errorCount = 0;
  let warnCount = 0;

  for (const d of diagnostics) {
    const resource = (d.data as any)?.resource as { kind: string; name: string } | undefined;
    const m = resource ? manifestByKey.get(`${resource.kind}.${resource.name}`) : undefined;
    const absSource = (m?.metadata as any)?.source as string | undefined;
    const displaySource = absSource
      ? isUrl
        ? absSource
        : path.relative(process.cwd(), absSource)
      : isUrl
        ? entryPath
        : path.relative(process.cwd(), entryPath);
    const sourceLine = (m?.metadata as any)?.sourceLine as number | undefined;
    const positionIndex = (m?.metadata as any)?.positionIndex as PositionIndex | undefined;
    const fieldPath = (d.data as any)?.path as string | undefined;

    const fieldRange =
      fieldPath !== undefined && positionIndex ? positionIndex.get(fieldPath) : undefined;
    const line = (fieldRange?.start.line ?? sourceLine ?? 0) + 1;
    const col = (fieldRange?.start.character ?? 0) + 1;

    const loc = `${displaySource}:${line}:${col}`;
    const severityLabel =
      (d.severity ?? DiagnosticSeverity.Warning) <= DiagnosticSeverity.Error
        ? log.error("error")
        : log.warn("warning");
    const code = d.code ? `  ${log.dim(String(d.code))}` : "";

    console.log(`${loc}  ${severityLabel}  ${d.message}${code}`);

    if ((d.severity ?? DiagnosticSeverity.Warning) <= DiagnosticSeverity.Error) errorCount++;
    else warnCount++;
  }

  return { errorCount, warnCount };
}

async function check(argv: { paths: string[] }) {
  const log = createLogger(false);

  let totalErrors = 0;
  let totalWarns = 0;

  for (const p of argv.paths) {
    const { errorCount, warnCount } = await checkOne(p, log);
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
    "check <paths..>",
    "Check one or more Telo manifests for errors without running them",
    (yargs) =>
      yargs.positional("paths", {
        describe: "Paths to YAML manifests, directories containing module.yaml, or HTTP(S) URLs",
        type: "string",
        array: true,
        demandOption: true,
      }),
    async (argv) => {
      await check(argv as any);
    },
  )
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

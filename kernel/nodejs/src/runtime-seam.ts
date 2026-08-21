import {
  Loader,
  StaticAnalyzer,
  collectZoneModuleDocuments,
  diagnosticFix,
  flattenForAnalyzer,
  remapMigratedPaths,
  type AnalysisDiagnostic,
  type DiagnosticData,
  type LoadedGraph,
  type ManifestSource,
  type ZoneModuleDocuments,
} from "@telorun/analyzer";
import {
  Stream,
  type RuntimeCheckOptions,
  type RuntimeCheckResult,
  type CheckDiagnostic,
  type CheckDiagnosticSeverity,
  type RuntimeRun,
  type RuntimeRunOptions,
  type RuntimeSeam,
} from "@telorun/sdk";
import { Writable } from "stream";
import { nodeHostVersions } from "./host-versions.js";
import { nodeCelHandlers } from "./cel-handlers.js";
import type { Kernel } from "./kernel.js";
import { defaultTransportRegistry } from "./transports/transport-registry.js";

/**
 * How many unconsumed chunks a channel holds before it stops acknowledging the
 * child's writes.
 *
 * This is a courtesy, **not a memory bound**, and the distinction matters enough
 * to state: withholding a `Writable`'s `_write` callback only moves subsequent
 * chunks into the stream's own internal buffer, which is unbounded, and a
 * controller writing to `ctx.stdout` does not await `drain`. So a child whose
 * output nobody reads still grows the host's memory. What actually bounds it is
 * `RuntimeRun.cancel()` — stopping the child, rather than hoping it stops
 * producing. What the high-water mark does buy is that a *slow* consumer sees
 * chunks handed over in order without the channel racing ahead of it.
 */
const CHANNEL_HIGH_WATER_MARK = 256;

interface PendingChunk {
  text: string;
  /** The child's `_write` callback, held back once the channel is over its
   *  high-water mark and released when a consumer takes the chunk. */
  release?: () => void;
}

/**
 * One direction of a child's output: a `Writable` the child kernel writes to,
 * and the {@link Stream} the caller reads. Bridges Node's stream model to the
 * SDK's without either side seeing the other's — `RuntimeSeam` has no
 * `Writable` in it, and the child kernel has no `Stream` in it.
 */
class OutputChannel {
  #queue: PendingChunk[] = [];
  #waiters: Array<(result: IteratorResult<string>) => void> = [];
  #ended = false;

  readonly writable: Writable = new Writable({
    write: (chunk: Buffer | string, _encoding, callback) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.#push(text, callback);
    },
  });

  readonly stream: Stream<string> = new Stream<string>({
    [Symbol.asyncIterator]: () => ({
      next: () => this.#next(),
    }),
  });

  /** No more output is coming. Wakes every waiter with a terminal result, so a
   *  `for await` over the stream completes rather than hanging on a child that
   *  has already exited. */
  end(): void {
    this.#ended = true;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()!({ value: undefined, done: true });
    }
  }

  #push(text: string, callback: () => void): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: text, done: false });
      callback();
      return;
    }
    if (this.#queue.length >= CHANNEL_HIGH_WATER_MARK) {
      this.#queue.push({ text, release: callback });
      return;
    }
    this.#queue.push({ text });
    callback();
  }

  async #next(): Promise<IteratorResult<string>> {
    const pending = this.#queue.shift();
    if (pending) {
      pending.release?.();
      return { value: pending.text, done: false };
    }
    if (this.#ended) return { value: undefined, done: true };
    return new Promise<IteratorResult<string>>((resolve) => this.#waiters.push(resolve));
  }
}

const SEVERITY_NAMES: Record<number, CheckDiagnosticSeverity> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

/** Flatten an analyzer finding to the seam's plain-data shape. Severity becomes
 *  a name because the integer is an LSP protocol detail, and this contract is
 *  read by kernels that speak no LSP. An unlabelled severity is an error: the
 *  analyzer's own default, and the safe reading for a caller gating on it. */
function toCheckDiagnostic(diagnostic: AnalysisDiagnostic): CheckDiagnostic {
  // The repair is read through the analyzer's accessor rather than by casting
  // `data`, so the stamp's shape stays owned by one module. `resource` / `path`
  // ride along because a repair replaces the value AT `path`; forwarding the
  // fix without its anchor gives a consumer something it cannot apply.
  const fix = diagnosticFix(diagnostic);
  const stamp = diagnostic.data as DiagnosticData | undefined;
  return {
    code: String(diagnostic.code ?? ""),
    message: diagnostic.message,
    severity: SEVERITY_NAMES[diagnostic.severity ?? 1] ?? "error",
    source: diagnostic.source,
    line: diagnostic.range?.start?.line,
    column: diagnostic.range?.start?.character,
    ...(stamp?.resource ? { resource: `${stamp.resource.kind}/${stamp.resource.name}` } : {}),
    ...(stamp?.path ? { path: stamp.path } : {}),
    ...(fix ? { fix: { replacement: fix.replacement } } : {}),
  };
}

/**
 * The kernel's implementation of the SDK's {@link RuntimeSeam} — run a manifest,
 * analyze a manifest — built over the `Kernel`, `Loader` and `StaticAnalyzer`
 * this kernel already owns.
 *
 * Isolation is this class's choice, not the caller's: today a child `Kernel` in
 * the same process, later a subprocess. That is what keeps process-global host
 * state (the `process.env` guardrail is additive across in-process kernels) an
 * implementation detail rather than something a module author has to know.
 */
export class KernelRuntimeSeam implements RuntimeSeam {
  constructor(private readonly kernel: Kernel) {}

  async run(source: string, options?: RuntimeRunOptions): Promise<RuntimeRun> {
    // Import here rather than at module scope: `resource-context.ts` imports this
    // file to construct the seam and `kernel.ts` imports *that*, so a top-level
    // import of `Kernel` here would close the cycle. The dynamic import resolves
    // after both modules are evaluated.
    const { Kernel: ChildKernel } = await import("./kernel.js");
    const stdout = new OutputChannel();
    const stderr = new OutputChannel();

    const child = new ChildKernel({
      env: options?.env ?? this.kernel.env,
      stdout: stdout.writable,
      stderr: stderr.writable,
      sources: [...this.kernel.injectedSources],
      registryUrl: this.kernel.registryUrl,
    });

    // A child that fails to load is not an exception on this side: the caller
    // asked to run a manifest and the answer is "it exited non-zero, here is
    // why", which keeps both failure modes on one path. `start()` tears the
    // child down in its own `finally`, so this only has to close the channels.
    const exitCode = (async () => {
      try {
        // The child runs a manifest in the SAME workspace as its parent, so it
        // shares the root the parent already resolved instead of deriving one
        // beside the child manifest. Deriving put a `.telo` in every directory
        // holding a test manifest and rebuilt every controller bundle once per
        // test, since `Test.Suite` runs each test through here.
        //
        // `undefined` means "resolve one yourself" and `null` means "no cache" —
        // a parent with no local anchor must yield the first, not the second.
        await child.load(source, { cacheDir: this.kernel.getCacheRoot() ?? undefined });
        await child.start();
        return child.exitCode;
      } catch (err) {
        stderr.writable.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return child.exitCode === 0 ? 1 : child.exitCode;
      } finally {
        stdout.end();
        stderr.end();
      }
    })();

    let cancelled: Promise<void> | undefined;
    const cancel = (reason = "cancelled"): Promise<void> => {
      // Idempotent: repeated calls await the first teardown rather than starting
      // another. `teardown()` is itself idempotent, but a second `forceIdle()`
      // against a kernel already unwinding buys nothing.
      cancelled ??= (async () => {
        // Cancel the boot run first so an in-flight target observes it, then
        // release `waitForIdle` so `start()`'s own `finally` performs the
        // teardown — the same path a SIGINT takes. Awaiting `exitCode` is what
        // makes "resolves when teardown has completed" true.
        child.cancel(reason);
        child.forceIdle();
        await exitCode;
      })();
      return cancelled;
    };

    return { stdout: stdout.stream, stderr: stderr.stream, exitCode, cancel };
  }

  async check(source: string, options?: RuntimeCheckOptions): Promise<RuntimeCheckResult> {
    // A fresh loader over this kernel's own resolution chain — the transports it
    // was configured with plus whatever sources were injected — so `check()`
    // resolves an import exactly as a run of the same manifest would. Fresh
    // rather than the kernel's own loader because a checked manifest is often
    // deliberately broken and has no business entering the running kernel's
    // parse cache.
    const loader = new Loader(defaultTransportRegistry(this.kernel.registryUrl).sources(), {
      celHandlers: nodeCelHandlers,
    });
    for (const injected of this.kernel.injectedSources) {
      loader.register(injected as ManifestSource);
    }

    let manifests;
    // Parse failures and version reconciliation are the loader's findings, not
    // `analyze()`'s — carried out of the try so the checks below can see them.
    let parseDiagnostics: AnalysisDiagnostic[] = [];
    let versionDiagnostics: AnalysisDiagnostic[] = [];
    let migrationDiagnostics: AnalysisDiagnostic[] = [];
    let moduleDocuments: ZoneModuleDocuments[] = [];
    // Carried out of the try for the same reason the diagnostics are: analysis
    // runs over the MIGRATED tree while every path a caller resolves points at
    // the raw file, so the driver's provenance record has to be in hand below.
    let loadedGraph: LoadedGraph | undefined;
    try {
      // `migrate` unconditionally: this seam answers "does this manifest load
      // and check", and the runtime it stands in for reads a legacy spelling
      // through the same rewrite. A raw view is a round-trip editor's need, not
      // a supervisor's.
      const graph = await loader.loadGraph(source, {
        desugarImports: options?.desugarImports ?? true,
        migrate: true,
      });
      if (graph.errors.length > 0) throw graph.errors[0].error;
      loadedGraph = graph;
      parseDiagnostics = graph.parseDiagnostics;
      versionDiagnostics = graph.versionDiagnostics;
      migrationDiagnostics = graph.migrationDiagnostics;
      manifests = flattenForAnalyzer(graph);
      // The zone stage derives each imported library's export contracts from
      // its own full documents, which the flattened list drops.
      moduleDocuments = collectZoneModuleDocuments(graph);
    } catch (err) {
      // A graph that would not load is an answer, not a failure of the call —
      // "this manifest does not load, and here is the reason" is precisely what
      // a caller asked for. Throwing would force every caller to re-express the
      // distinction in a catch.
      return {
        diagnostics: [],
        loadError: err instanceof Error ? err.message : String(err),
      };
    }

    // A file that fails to parse is not dropped — it reaches the flattened list
    // as a mangled `toJSON()` tree, and analyzing that buries the real error
    // under a cascade of secondaries which exist only because the parse failed.
    // Report the parse findings and stop, the policy `load()` already applies by
    // treating a parse failure as fatal before analysis.
    if (parseDiagnostics.length > 0) {
      return {
        diagnostics: [...parseDiagnostics, ...migrationDiagnostics, ...versionDiagnostics].map(
          toCheckDiagnostic,
        ),
      };
    }

    // `analyze()` never sees version skew, so without merging these a major
    // mismatch — which `load()` refuses to boot on — would check clean.
    //
    // The remap is the same call `assembleGraphDiagnostics` makes for the CLI
    // and VS Code, and it is not optional here: a caller acts on `path` (a
    // module's `Assert.Manifest` matches on it), so this seam reporting the
    // MIGRATED spelling while every other surface reports the author's would
    // make one manifest mean two things depending on who asked. A no-op when
    // nothing was migrated.
    const analysis = new StaticAnalyzer({ celHandlers: nodeCelHandlers }).analyze(manifests, {
      moduleDocuments,
      hostVersions: nodeHostVersions(),
    });
    const diagnostics = remapMigratedPaths(loadedGraph, analysis);
    return {
      diagnostics: [...migrationDiagnostics, ...versionDiagnostics, ...diagnostics].map(
        toCheckDiagnostic,
      ),
    };
  }
}

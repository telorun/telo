import {
  Loader,
  StaticAnalyzer,
  assembleGraphDiagnostics,
  collectModuleDocuments,
  diagnosticFix,
  flattenForAnalyzer,
  locateDiagnostic,
  type AnalysisDiagnostic,
  type DiagnosticData,
  type LoadedGraph,
  type ManifestSource,
} from "@telorun/analyzer";
import {
  Stream,
  type RuntimeCheckOptions,
  type RuntimeCheckResult,
  type RuntimeDiagnostic,
  type CheckDiagnostic,
  type CheckDiagnosticSeverity,
  type RuntimeRun,
  type RuntimeRunOptions,
  type RuntimeSeam,
} from "@telorun/sdk";
import { PassThrough, Writable } from "stream";
import { nodeHostVersions } from "./host-versions.js";
import { nodeCelHandlers } from "./cel-handlers.js";
import type { Kernel } from "./kernel.js";
import { defaultTransportRegistry } from "./transports/transport-registry.js";
import { withoutPublicUrlHostValues } from "./public-urls.js";

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

/**
 * The write end of a child's input: a `Readable` the child kernel reads, and the
 * `write` / `end` the caller drives it with.
 *
 * A `PassThrough` rather than a pre-built `Readable.from(text)`, because the
 * caller writes over time — answering a prompt the child has just printed — and
 * a readable built from a value can only ever deliver what was known before the
 * child started. `write` resolves when the stream has taken the text, so a
 * caller that awaits it cannot outrun the child's buffer.
 */
class InputChannel {
  readonly readable = new PassThrough({ encoding: "utf8" });
  #ended = false;

  async write(text: string): Promise<void> {
    if (this.#ended) {
      throw new Error(
        "Cannot write to a child application's input after it has been ended — " +
          "the child has already been told no more input is coming.",
      );
    }
    await new Promise<void>((resolve, reject) => {
      this.readable.write(text, (err) => (err ? reject(err) : resolve()));
    });
  }

  async end(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    await new Promise<void>((resolve) => this.readable.end(resolve));
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
function toCheckDiagnostic(diagnostic: AnalysisDiagnostic, graph: LoadedGraph): CheckDiagnostic {
  // The repair is read through the analyzer's accessor rather than by casting
  // `data`, so the stamp's shape stays owned by one module. `resource` / `path`
  // ride along because a repair replaces the value AT `path`; forwarding the
  // fix without its anchor gives a consumer something it cannot apply.
  const fix = diagnosticFix(diagnostic);
  const stamp = diagnostic.data as DiagnosticData | undefined;
  const range = locateDiagnostic(graph, diagnostic)?.range;
  return {
    code: String(diagnostic.code ?? ""),
    message: diagnostic.message,
    severity: SEVERITY_NAMES[diagnostic.severity ?? 1] ?? "error",
    source: diagnostic.source,
    ...(range ? { line: range.start.line, column: range.start.character } : {}),
    ...(stamp?.resource ? { resource: `${stamp.resource.kind}/${stamp.resource.name}` } : {}),
    ...(stamp?.path ? { path: stamp.path } : {}),
    ...(fix
      ? { fix: { replacement: fix.replacement, ...(fix.tag ? { tag: fix.tag } : {}) } }
      : {}),
  };
}

/**
 * What a refused child writes to its stderr (the `RuntimeSeam.run` contract):
 * the failure's own message, then one `  [<CODE>] <message>` line per
 * diagnostic it carries — `details` and further message lines beneath it, a
 * nested context's `children` one level further in, `derived` entries left out
 * as `telo run` leaves them out. No location: the located form is `check()`'s.
 */
export function refusedRunText(err: unknown): string {
  const lines = [err instanceof Error ? err.message : String(err)];
  const write = (diagnostics: RuntimeDiagnostic[], indent: string): void => {
    for (const d of diagnostics) {
      if (!d.derived) {
        const [first, ...rest] = d.message.split("\n");
        lines.push(`${indent}${d.code ? `[${d.code}] ` : ""}${first}`);
        const beneath = [...rest, ...(d.details ? d.details.split("\n") : [])];
        lines.push(...beneath.map((line) => `${indent}  ${line}`));
      }
      // A nested context's root causes are not shadows of a derived wrapper.
      if (d.children?.length) write(d.children, `${indent}  `);
    }
  };
  const carried = (err as { diagnostics?: RuntimeDiagnostic[] } | null)?.diagnostics;
  if (Array.isArray(carried)) write(carried, "  ");
  return `${lines.join("\n")}\n`;
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
    const stdin = new InputChannel();

    const child = new ChildKernel({
      // The parent's address host values answer the parent's needs, never the child's.
      env: options?.env ?? withoutPublicUrlHostValues(this.kernel.env),
      stdout: stdout.writable,
      stderr: stderr.writable,
      sources: [...this.kernel.injectedSources],
      inputs: options?.inputs,
      // A child reads what the caller writes it, never the host's own input:
      // two children sharing one terminal would race for the same lines.
      stdin: stdin.readable,
    });

    // Subscribed BEFORE the child is started, or a child that starts within the
    // same turn would emit into no listener and this would wait for an event
    // that has already happened.
    const started = new Promise<void>((resolve) => {
      child.on("Kernel.Started", () => resolve());
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
        stderr.writable.write(refusedRunText(err));
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
        // Input first: a child parked on a read has no other reason to wake,
        // and cancelling one that is still waiting for a line it will never be
        // given leaves the wait as the last thing in its log.
        await stdin.end();
        child.cancel(reason);
        child.forceIdle();
        await exitCode;
      })();
      return cancelled;
    };

    // Raced against the exit so the wait always ends: a child that fails to
    // load, or one whose work is over before it finishes starting, settles
    // `exitCode` and never emits `Kernel.Started`. Handed to the caller rather
    // than awaited here — see `RuntimeRun.started` for why an interactive child
    // must not wait for it.
    const startedOrExited = Promise.race([started, exitCode.then(() => undefined)]);

    return {
      started: startedOrExited,
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin: { write: (text: string) => stdin.write(text), end: () => stdin.end() },
      exitCode,
      cancel,
    };
  }

  async check(source: string, options?: RuntimeCheckOptions): Promise<RuntimeCheckResult> {
    // A fresh loader over this kernel's own resolution chain — the transports it
    // was configured with plus whatever sources were injected — so `check()`
    // resolves an import exactly as a run of the same manifest would. Fresh
    // rather than the kernel's own loader because a checked manifest is often
    // deliberately broken and has no business entering the running kernel's
    // parse cache.
    const loader = new Loader(defaultTransportRegistry().sources(), {
      celHandlers: nodeCelHandlers,
    });
    for (const injected of this.kernel.injectedSources) {
      loader.register(injected as ManifestSource);
    }

    let graph: LoadedGraph;
    try {
      // `migrate` unconditionally: this seam answers "does this manifest load
      // and check", and the runtime it stands in for reads a legacy spelling
      // through the same rewrite. A raw view is a round-trip editor's need, not
      // a supervisor's.
      graph = await loader.loadGraph(source, {
        desugarImports: options?.desugarImports ?? true,
        migrate: true,
      });
    } catch (err) {
      // A graph that would not load at all is an answer, not a failure of the
      // call. A failed IMPORT is not this case: the loader records it and loads
      // the rest, and it is reported below as the coded diagnostic `telo check`
      // reports.
      return {
        diagnostics: [],
        loadError: err instanceof Error ? err.message : String(err),
      };
    }

    // The analysis and the assembly `telo check` performs, so a caller reads
    // the same codes, messages and locations: the compromised-file cascade held
    // back, migrated paths remapped, every diagnostic located by the shared rule.
    const analysis = new StaticAnalyzer({ celHandlers: nodeCelHandlers }).analyze(
      flattenForAnalyzer(graph),
      {
        // The zone stage derives each imported library's export contracts from
        // its own full documents, which the flattened list drops.
        moduleDocuments: collectModuleDocuments(graph),
        hostVersions: nodeHostVersions(),
      },
    );
    const { diagnostics } = assembleGraphDiagnostics(graph, analysis);
    return { diagnostics: diagnostics.map((d) => toCheckDiagnostic(d, graph)) };
  }
}

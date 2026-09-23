import type { CancellationToken } from "@telorun/sdk";

/**
 * A fixed set of engines serving calls in arrival order, each engine one
 * recognition at a time.
 *
 * An engine runs synchronous WebAssembly in a worker thread, so the only way to
 * stop a recognition is to terminate its worker. The pool therefore owns every
 * stop — a cancelled call, a recognition past its time limit, a crashed engine —
 * and replaces the engine it stopped, so the pool keeps its size.
 */

/** One engine, as the pool drives it. */
export interface PoolEngine<TJob, TResult> {
  /** Run one job. Rejects with {@link EngineLostError} when the engine died
   *  during it; any other rejection is the job's own failure. */
  run(job: TJob): Promise<TResult>;
  /** Stop the engine. Idempotent. */
  terminate(): Promise<void>;
  /** Called once when the engine dies without being terminated. */
  onLost(listener: (cause: Error) => void): void;
}

/** The engine is gone: it crashed, aborted, or was terminated. */
export class EngineLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineLostError";
  }
}

export interface PoolLogger {
  warn(message: string, attributes?: Record<string, string | number>): void;
  error(message: string, attributes?: Record<string, string | number>): void;
}

export interface RecognitionPoolOptions<TJob, TResult> {
  readonly size: number;
  /** Calls allowed to wait beyond the running ones. */
  readonly queueLimit: number;
  /** How long one job may hold an engine once it starts. */
  readonly maxRunMs: number;
  readonly startEngine: () => Promise<PoolEngine<TJob, TResult>>;
  /** Builds the error a caller receives, carrying one of the contract's codes. */
  readonly fail: (code: string, message: string) => Error;
  readonly log: PoolLogger;
}

interface Call<TJob, TResult> {
  readonly job: TJob;
  readonly token: CancellationToken;
  readonly resolve: (result: TResult) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
  unsubscribe?: () => void;
}

export class RecognitionPool<TJob, TResult> {
  private readonly idle: PoolEngine<TJob, TResult>[] = [];
  private readonly busy = new Map<PoolEngine<TJob, TResult>, Call<TJob, TResult>>();
  private readonly retired = new WeakSet<PoolEngine<TJob, TResult>>();
  private readonly queue: Call<TJob, TResult>[] = [];
  private readonly starting = new Set<Promise<void>>();
  private lastStartFailure: Error | undefined;
  private closed = false;

  constructor(private readonly options: RecognitionPoolOptions<TJob, TResult>) {}

  /** Start every engine; if any fails, stop the ones that started and throw its failure. */
  async start(): Promise<void> {
    const started = await Promise.allSettled(
      Array.from({ length: this.options.size }, () => this.options.startEngine()),
    );
    const failure = started.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failure) {
      await Promise.all(
        started.flatMap((s) => (s.status === "fulfilled" ? [s.value.terminate()] : [])),
      );
      throw failure.reason;
    }
    for (const s of started) this.adopt((s as PromiseFulfilledResult<PoolEngine<TJob, TResult>>).value);
  }

  submit(job: TJob, token: CancellationToken): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      if (token.isCancelled) return reject(cancellationError(token, this.options.fail));
      if (this.closed) {
        return reject(this.options.fail("ERR_OCR_ENGINE_FAILED", "The recognizer has been torn down."));
      }
      const call: Call<TJob, TResult> = { job, token, resolve, reject, settled: false };
      const engine = this.idle.pop();
      if (engine) return this.dispatch(engine, call);
      // Below size after a failed replacement: try again rather than stay short.
      if (this.busy.size + this.starting.size < this.options.size) this.replace();
      if (this.queue.length >= this.options.queueLimit) {
        return reject(
          this.options.fail(
            "ERR_OCR_OVERLOADED",
            `All ${this.options.size} engines are busy and ${this.options.queueLimit} calls are already waiting.`,
          ),
        );
      }
      this.queue.push(call);
      call.unsubscribe = token.onCancelled(() => {
        const at = this.queue.indexOf(call);
        if (at !== -1) this.queue.splice(at, 1);
        this.settle(call, () => call.reject(cancellationError(token, this.options.fail)));
      });
    });
  }

  /** Stop every engine, including those still starting, and fail every waiting call. */
  async close(): Promise<void> {
    this.closed = true;
    const torn = () =>
      this.options.fail("ERR_OCR_ENGINE_FAILED", "The recognizer was torn down during the call.");
    for (const call of this.queue.splice(0)) this.settle(call, () => call.reject(torn()));
    const engines = [...this.idle.splice(0), ...this.busy.keys()];
    for (const [engine, call] of this.busy) {
      this.retired.add(engine);
      this.settle(call, () => call.reject(torn()));
    }
    this.busy.clear();
    await Promise.all([...engines.map((engine) => engine.terminate()), ...this.starting]);
  }

  private adopt(engine: PoolEngine<TJob, TResult>): void {
    engine.onLost((cause) => {
      if (this.retired.has(engine)) return;
      const idleAt = this.idle.indexOf(engine);
      if (idleAt !== -1) this.idle.splice(idleAt, 1);
      // A busy engine's call is failed by its own `run()` rejection.
      if (!this.busy.has(engine)) this.retire(engine, cause.message);
    });
    this.idle.push(engine);
    this.pump();
  }

  private dispatch(engine: PoolEngine<TJob, TResult>, call: Call<TJob, TResult>): void {
    call.unsubscribe?.();
    if (call.token.isCancelled) {
      this.settle(call, () => call.reject(cancellationError(call.token, this.options.fail)));
      this.idle.push(engine);
      this.pump();
      return;
    }
    this.busy.set(engine, call);
    const timer = setTimeout(() => {
      this.settle(call, () =>
        call.reject(
          this.options.fail(
            "ERR_OCR_LIMIT_EXCEEDED",
            `The recognition ran longer than ${this.options.maxRunMs}ms; its engine was stopped and replaced.`,
          ),
        ),
      );
      this.retire(engine, "a recognition exceeded the time limit");
    }, this.options.maxRunMs);
    call.unsubscribe = call.token.onCancelled(() => {
      this.settle(call, () => call.reject(cancellationError(call.token, this.options.fail)));
      this.retire(engine, "a running call was cancelled");
    });
    const finish = () => clearTimeout(timer);
    engine.run(call.job).then(
      (result) => {
        finish();
        if (!this.settle(call, () => call.resolve(result))) return;
        this.release(engine);
      },
      (error: unknown) => {
        finish();
        if (error instanceof EngineLostError) {
          this.settle(call, () =>
            call.reject(
              this.options.fail(
                "ERR_OCR_ENGINE_FAILED",
                `The engine failed during the recognition and has been replaced: ${error.message}`,
              ),
            ),
          );
          this.retire(engine, error.message);
          return;
        }
        if (!this.settle(call, () => call.reject(error))) return;
        this.release(engine);
      },
    );
  }

  /** Settle a call once; false when it was already settled. */
  private settle(call: Call<TJob, TResult>, outcome: () => void): boolean {
    if (call.settled) return false;
    call.settled = true;
    call.unsubscribe?.();
    outcome();
    return true;
  }

  private release(engine: PoolEngine<TJob, TResult>): void {
    this.busy.delete(engine);
    if (this.closed || this.retired.has(engine)) return;
    this.idle.push(engine);
    this.pump();
  }

  private retire(engine: PoolEngine<TJob, TResult>, reason: string): void {
    if (this.retired.has(engine)) return;
    this.retired.add(engine);
    this.busy.delete(engine);
    const idleAt = this.idle.indexOf(engine);
    if (idleAt !== -1) this.idle.splice(idleAt, 1);
    engine.terminate().catch((error: unknown) => {
      this.options.log.error("Stopping an engine failed", { "error.message": describe(error) });
    });
    if (this.closed) return;
    this.options.log.warn("Replacing an engine", { reason });
    this.replace();
  }

  private replace(): void {
    const start: Promise<void> = this.options.startEngine().then(
      async (engine) => {
        this.starting.delete(start);
        // Torn down while starting: `close()` awaits this stop.
        if (this.closed) return engine.terminate();
        this.lastStartFailure = undefined;
        this.adopt(engine);
      },
      (error: unknown) => {
        this.starting.delete(start);
        this.lastStartFailure = error instanceof Error ? error : new Error(String(error));
        this.options.log.error("A replacement engine could not start", {
          "error.message": this.lastStartFailure.message,
        });
        if (this.closed || this.idle.length + this.busy.size + this.starting.size > 0) return;
        for (const call of this.queue.splice(0)) {
          this.settle(call, () => call.reject(this.noEngineError()));
        }
      },
    );
    this.starting.add(start);
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      this.dispatch(this.idle.pop()!, this.queue.shift()!);
    }
  }

  private noEngineError(): Error {
    const cause = this.lastStartFailure?.message ?? "no engine could be started";
    return this.options.fail(
      "ERR_OCR_ENGINE_FAILED",
      `No engine is left to recognize with: replacing a failed engine failed: ${cause}`,
    );
  }
}

/** The error the cancellation itself carries (`ERR_INVOKE_CANCELLED`). */
function cancellationError(token: CancellationToken, fail: (code: string, message: string) => Error): unknown {
  try {
    token.throwIfCancelled();
  } catch (error) {
    return error;
  }
  return fail("ERR_INVOKE_CANCELLED", token.reason ?? "Invoke cancelled");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

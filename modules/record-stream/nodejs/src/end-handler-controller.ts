import type { InvokeContext, Logger, ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  ERR_INVOKE_CANCELLED,
  InvokeError,
  NEVER_CANCELLED,
  Stream,
  UNCANCELLABLE_CONTEXT,
  deriveContext,
  isCancellationError,
  isSuspension,
  resolveInvocableDispatcher,
} from "@telorun/sdk";
import { type RecordedError, recordedError } from "./recorded-error.js";

interface EndHandlerResource {
  metadata: { name: string; module?: string };
  handler?: unknown;
  /** The handler's arguments: a map the kernel leaves unevaluated, over the
   *  `records`, `outcome` and `context` bindings. */
  inputs?: Record<string, unknown>;
}

interface EndHandlerInputs {
  input: AsyncIterable<unknown>;
  context?: unknown;
}

interface EndHandlerOutputs {
  output: Stream<unknown>;
}

/** How a stream ended — the `RecordStream.StreamOutcome` shape. */
export interface StreamOutcome {
  state: "completed" | "failed" | "cancelled";
  error: RecordedError | null;
}

type Dispatch = (inputs: Record<string, unknown>, invokeCtx?: InvokeContext) => Promise<unknown>;

/** What the author's `inputs:` map is evaluated over, once per ending. */
interface EndingBindings {
  records: unknown[];
  outcome: StreamOutcome;
  context: unknown;
}

interface ObservedStreamOptions {
  name: string;
  input: AsyncIterable<unknown>;
  context: unknown;
  /** Evaluates the `inputs:` map over one ending's bindings. */
  handlerInputs: (bindings: EndingBindings) => Record<string, unknown>;
  dispatch: Dispatch;
  invokeCtx: InvokeContext | undefined;
  log: Logger;
}

const DONE: IteratorResult<unknown> = { value: undefined, done: true };

/**
 * Attach the stream's own ending to the handler's failure. A handler error that
 * already carries a cause keeps it, beside the ending.
 */
function withCause(err: unknown, cause: unknown): unknown {
  const target = typeof err === "object" && err !== null ? err : new Error(String(err));
  const existing = Object.prototype.hasOwnProperty.call(target, "cause")
    ? (target as { cause?: unknown }).cause
    : undefined;
  Object.defineProperty(target, "cause", {
    value:
      existing === undefined
        ? cause
        : new AggregateError([existing, cause], "the handler's own cause, then the error that ended the stream"),
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return target;
}

/**
 * The forwarded stream. An iterator rather than an async generator, because a
 * generator's `return()` waits for a pending `next()` — here the consumer
 * stopping, or the invocation being cancelled, ends the stream at once, even
 * while a pull is in flight. Every ending closes it synchronously first, so the
 * handler runs exactly once whichever path gets there.
 */
class ObservedStream implements AsyncIterableIterator<unknown> {
  private readonly records: unknown[] = [];
  private iterator: AsyncIterator<unknown> | undefined;
  private pending: Promise<IteratorResult<unknown>> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private ended = false;
  private cancelled: InvokeError | undefined;
  private rejectCancelled: (err: InvokeError) => void = () => undefined;
  /** Rejects once the invocation is cancelled; raced against every pull. */
  private readonly cancellation: Promise<never>;
  private readonly unlink: () => void;

  constructor(private readonly options: ObservedStreamOptions) {
    this.cancellation = new Promise<never>((_, reject) => {
      this.rejectCancelled = reject;
    });
    // Observed by the race in `step()`; this only keeps a cancellation between
    // pulls from reading as an unhandled rejection.
    this.cancellation.catch(() => undefined);
    const token = options.invokeCtx?.cancellation;
    this.unlink = token
      ? token.onCancelled((reason) => {
          this.cancelled = new InvokeError(
            ERR_INVOKE_CANCELLED,
            `RecordStream.EndHandler "${options.name}": the stream's invocation was cancelled (${reason ?? "no reason given"}).`,
          );
          this.rejectCancelled(this.cancelled);
        })
      : () => undefined;
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  next(): Promise<IteratorResult<unknown>> {
    const step = this.queue.then(() => this.step());
    this.queue = step.then(
      () => undefined,
      () => undefined,
    );
    return step;
  }

  /** The consumer stopped reading: end now, whatever is pending. */
  async return(): Promise<IteratorResult<unknown>> {
    if (this.ended) return DONE;
    this.close();
    await this.stopInput();
    const cancelled = this.cancelled;
    await this.runHandler(
      { state: "cancelled", error: cancelled ? recordedError(cancelled) : null },
      cancelled,
    );
    return DONE;
  }

  private close(): void {
    this.ended = true;
    this.unlink();
  }

  private async step(): Promise<IteratorResult<unknown>> {
    if (this.ended) return DONE;
    if (this.cancelled) return this.fail(this.cancelled, true);
    const iterator = (this.iterator ??= this.options.input[Symbol.asyncIterator]());
    const pending = iterator.next();
    this.pending = pending;
    let result: IteratorResult<unknown>;
    try {
      result = await Promise.race([pending, this.cancellation]);
    } catch (err) {
      const byCancellation = err === this.cancelled;
      if (!byCancellation) this.pending = undefined;
      // The consumer stopped while this pull was in flight; that ending ran.
      if (this.ended) return DONE;
      return this.fail(err, byCancellation);
    }
    this.pending = undefined;
    if (this.ended) return DONE;
    if (result.done) {
      this.close();
      await this.runHandler({ state: "completed", error: null }, undefined);
      return DONE;
    }
    this.records.push(result.value);
    return result;
  }

  /** End on an error: the input's own, or the invocation's cancellation. A
   *  suspension is not an ending — it passes through with no handler call. */
  private async fail(err: unknown, stopInput: boolean): Promise<never> {
    this.close();
    if (stopInput) await this.stopInput();
    if (isSuspension(err)) throw err;
    await this.runHandler(
      { state: isCancellationError(err) ? "cancelled" : "failed", error: recordedError(err) },
      err,
    );
    throw err;
  }

  /**
   * Stop the input. A pull still in flight cannot be awaited — the input may be
   * paused indefinitely — so its outcome is logged instead, as is a failure to
   * stop. An input raising the cancellation it was stopped by is not a failure.
   */
  private async stopInput(): Promise<void> {
    const report = (err: unknown) => {
      if (isCancellationError(err)) return;
      this.options.log.warn(
        "RecordStream.EndHandler's input failed while it was being stopped",
        { resource: this.options.name },
        { error: err },
      );
    };
    const pending = this.pending;
    this.pending = undefined;
    pending?.catch(report);
    const iterator = this.iterator;
    if (!iterator?.return) return;
    if (pending) {
      iterator.return().catch(report);
      return;
    }
    await iterator.return().catch(report);
  }

  /** Evaluate the `inputs:` map once and run the handler with the result, on a
   *  context without the stream's cancellation, so it can still do its work when
   *  the ending IS that cancellation. A map that fails to evaluate is a handler
   *  failure. */
  private async runHandler(outcome: StreamOutcome, original: unknown): Promise<void> {
    const handlerCtx = deriveContext(this.options.invokeCtx ?? UNCANCELLABLE_CONTEXT, {
      cancellation: NEVER_CANCELLED,
    });
    try {
      const inputs = this.options.handlerInputs({
        records: this.records,
        outcome,
        context: this.options.context,
      });
      await this.options.dispatch(inputs, handlerCtx);
    } catch (handlerErr) {
      if (original === undefined || isSuspension(handlerErr)) throw handlerErr;
      throw withCause(handlerErr, original);
    }
  }
}

/**
 * RecordStream.EndHandler — forwards a stream item by item and runs its handler
 * exactly once on whichever ending the stream reaches: completed, failed,
 * cancelled by its invocation, or stopped by its consumer. The handler is called
 * with the author's `inputs:` map, evaluated over `records`, `outcome` and
 * `context` — the controller builds no argument of its own, so what the handler
 * receives is exactly what `telo check` compared against its contract. It is
 * resolved and captured with the
 * invocation's context here, as `Stream.Tap` does, rather than read from
 * whoever happens to drain the stream.
 */
class EndHandler implements ResourceInstance<EndHandlerInputs, EndHandlerOutputs> {
  constructor(
    private readonly resource: EndHandlerResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: EndHandlerInputs, invokeCtx?: InvokeContext): Promise<EndHandlerOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
      throw new InvokeError("ERR_INVALID_INPUT", `RecordStream.EndHandler "${name}": 'input' must be a stream.`);
    }
    const dispatch = resolveInvocableDispatcher(
      this.resource.handler,
      this.ctx,
      () => `RecordStream.EndHandler "${name}"`,
    );
    const observed = new ObservedStream({
      name,
      input,
      context: inputs.context,
      handlerInputs: (bindings) =>
        this.ctx.expandValue(this.resource.inputs, { ...bindings }) as Record<string, unknown>,
      dispatch,
      invokeCtx,
      log: this.ctx.log,
    });
    return { output: new Stream(observed) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: EndHandlerResource, ctx: ResourceContext): Promise<EndHandler> {
  return new EndHandler(resource, ctx);
}

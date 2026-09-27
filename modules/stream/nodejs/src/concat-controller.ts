import type { InvokeContext, Logger, ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  ERR_INVOKE_CANCELLED,
  InvokeError,
  Stream,
  isCancellationError,
  resolveInvocableDispatcher,
} from "@telorun/sdk";

interface ConcatSourceDeclaration {
  invoke?: unknown;
  /** The source's arguments: a map the kernel leaves unevaluated, over `context`. */
  inputs?: Record<string, unknown>;
}

interface ConcatResource {
  metadata: { name: string; module?: string };
  sources?: ConcatSourceDeclaration[];
}

interface ConcatInputs {
  context?: Record<string, unknown>;
}

interface ConcatOutputs {
  output: Stream<unknown>;
}

type Dispatch = (inputs: Record<string, unknown>, invokeCtx?: InvokeContext) => Promise<unknown>;

/** One source, resolved: dispatching it evaluates its arguments first. */
interface ConcatSource {
  dispatch: Dispatch;
  inputs: (bindings: { context: Record<string, unknown> }) => Record<string, unknown>;
}

interface ConcatStreamOptions {
  name: string;
  sources: ConcatSource[];
  context: Record<string, unknown>;
  invokeCtx: InvokeContext | undefined;
  log: Logger;
}

const DONE: IteratorResult<unknown> = { value: undefined, done: true };

/** What ends a wait early: the consumer stopping, or the invocation's cancellation. */
type Interruption = { kind: "stopped" } | { kind: "cancelled"; error: InvokeError };

const INTERRUPTED = Symbol("interrupted");

/**
 * The concatenated stream. An iterator rather than an async generator, because a
 * generator's `return()` waits for a pending `next()` — here the consumer
 * stopping, or the invocation being cancelled, ends the stream at once, even
 * while a source is being invoked or pulled, and stops that source.
 */
class ConcatStream implements AsyncIterableIterator<unknown> {
  /** Index of the next source to invoke. */
  private position = 0;
  private iterator: AsyncIterator<unknown> | undefined;
  private pending: Promise<IteratorResult<unknown>> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private ended = false;
  private interruption: Interruption | undefined;
  private signal: (interruption: Interruption) => void = () => undefined;
  /** Resolves on the first interruption; raced against every invocation and pull. */
  private readonly interrupted: Promise<typeof INTERRUPTED>;
  private readonly unlink: () => void;

  constructor(private readonly options: ConcatStreamOptions) {
    this.interrupted = new Promise((resolve) => {
      this.signal = (interruption) => {
        this.interruption ??= interruption;
        resolve(INTERRUPTED);
      };
    });
    const token = options.invokeCtx?.cancellation;
    this.unlink = token
      ? token.onCancelled((reason) =>
          this.signal({
            kind: "cancelled",
            error: new InvokeError(
              ERR_INVOKE_CANCELLED,
              `Stream.Concat "${options.name}": the stream's invocation was cancelled (${reason ?? "no reason given"}).`,
            ),
          }),
        )
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

  /** The consumer stopped reading: end now, whatever is pending, and stop the
   *  current source. No further source is invoked. */
  async return(): Promise<IteratorResult<unknown>> {
    if (this.ended) return DONE;
    this.signal({ kind: "stopped" });
    this.close();
    await this.stopSource();
    return DONE;
  }

  private close(): void {
    this.ended = true;
    this.unlink();
  }

  private async step(): Promise<IteratorResult<unknown>> {
    if (this.ended) return DONE;
    if (this.interruption) return this.interrupt();
    let result: IteratorResult<unknown> | typeof INTERRUPTED;
    try {
      result = await this.advance();
    } catch (err) {
      // A source failed — its invocation or its stream — so no later one runs.
      // A consumer that stopped meanwhile has already ended the stream.
      if (this.ended) return DONE;
      this.pending = undefined;
      this.close();
      await this.stopSource();
      throw err;
    }
    return result === INTERRUPTED ? this.interrupt() : result;
  }

  /** The next item, invoking sources in order as each one's stream ends. */
  private async advance(): Promise<IteratorResult<unknown> | typeof INTERRUPTED> {
    while (true) {
      if (!this.iterator) {
        if (this.position >= this.options.sources.length) {
          this.close();
          return DONE;
        }
        const iterator = await this.open(this.position++);
        if (iterator === INTERRUPTED) return INTERRUPTED;
        this.iterator = iterator;
      }
      const pending = this.iterator.next();
      this.pending = pending;
      const result = await Promise.race([pending, this.interrupted]);
      if (result === INTERRUPTED) return INTERRUPTED;
      this.pending = undefined;
      if (!result.done) return result;
      this.iterator = undefined;
    }
  }

  /**
   * Invoke one source under the Concat's own invocation context and take its
   * `output` stream. When an interruption arrives first, the source's stream is
   * stopped once it resolves rather than read.
   */
  private async open(index: number): Promise<AsyncIterator<unknown> | typeof INTERRUPTED> {
    const source = this.options.sources[index];
    const invoked = (async () => {
      const result = await source.dispatch(source.inputs({ context: this.options.context }), this.options.invokeCtx);
      return this.outputOf(result, index);
    })();
    const first = await Promise.race([invoked, this.interrupted]);
    if (first !== INTERRUPTED) return first;
    invoked.then(
      (iterator) => iterator.return?.().catch((err) => this.report(err)),
      (err) => this.report(err),
    );
    return INTERRUPTED;
  }

  private outputOf(result: unknown, index: number): AsyncIterator<unknown> {
    const output = (result as { output?: unknown } | null | undefined)?.output;
    if (!output || typeof (output as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_VALUE",
        `Stream.Concat "${this.options.name}": sources[${index}] returned no 'output' stream; every source must return { output: <stream> }.`,
      );
    }
    return (output as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  }

  /** End on an interruption: quietly when the consumer stopped, with
   *  ERR_INVOKE_CANCELLED when the invocation was cancelled. */
  private interrupt(): IteratorResult<unknown> {
    const interruption = this.interruption!;
    if (interruption.kind === "stopped" || this.ended) return DONE;
    this.close();
    void this.stopSource();
    throw interruption.error;
  }

  /**
   * Stop the current source. A pull still in flight cannot be awaited — the
   * source may be paused indefinitely — so its outcome is logged instead, as is
   * a failure to stop.
   */
  private async stopSource(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    pending?.catch((err) => this.report(err));
    const iterator = this.iterator;
    this.iterator = undefined;
    if (!iterator?.return) return;
    if (pending) {
      iterator.return().catch((err) => this.report(err));
      return;
    }
    await iterator.return().catch((err) => this.report(err));
  }

  /** A source raising the cancellation it was stopped by is not a failure. */
  private report(err: unknown): void {
    if (isCancellationError(err)) return;
    this.options.log.warn(
      "Stream.Concat's source failed while it was being stopped",
      { resource: this.options.name },
      { error: err },
    );
  }
}

/**
 * Stream.Concat — the output streams of its sources, one after another. Nothing
 * is invoked by `invoke()`: the first source is invoked on the first pull and
 * each next one when the previous stream ends, under the Concat's own
 * invocation context, captured here as `Stream.Tap` does. A source's failure
 * ends the stream with its error and no later source runs; the consumer
 * stopping, or the invocation being cancelled, stops the current source and
 * invokes no further one.
 */
class StreamConcat implements ResourceInstance<ConcatInputs, ConcatOutputs> {
  constructor(
    private readonly resource: ConcatResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: ConcatInputs, invokeCtx?: InvokeContext): Promise<ConcatOutputs> {
    const name = this.resource.metadata.name;
    // Resolved before anything is pulled, so a bad reference fails this call.
    const sources = (this.resource.sources ?? []).map((source, index): ConcatSource => {
      const dispatch = resolveInvocableDispatcher(
        source.invoke,
        this.ctx,
        () => `Stream.Concat "${name}": sources[${index}]`,
      );
      return {
        dispatch,
        inputs: (bindings) =>
          source.inputs === undefined
            ? {}
            : (this.ctx.expandValue(source.inputs, bindings) as Record<string, unknown>),
      };
    });
    const stream = new ConcatStream({
      name,
      sources,
      context: inputs?.context ?? {},
      invokeCtx,
      log: this.ctx.log,
    });
    return { output: new Stream(stream) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: ConcatResource, ctx: ResourceContext): Promise<StreamConcat> {
  return new StreamConcat(resource, ctx);
}

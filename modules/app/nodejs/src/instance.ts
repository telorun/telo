import {
  InvokeError,
  Stream,
  type ResourceContext,
  type RuntimeRun,
  type TextChannel,
  type TextChannelInput,
} from "@telorun/sdk";
import { fileURLToPath } from "url";

interface InstanceResource {
  metadata: { name: string; module?: string };
  source: string;
  variables?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  ports?: Record<string, number>;
  awaitStart?: boolean;
}

/** A location the author wrote as a path into their own module, as opposed to a
 *  module reference (`oci://…`, an http URL) that resolves on its own. */
function isModuleRelative(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

/**
 * Another application, running as a resource of this one.
 *
 * `init()` does nothing on purpose. Starting a child is an observable effect —
 * it binds ports and writes to whatever the child writes to — so it belongs in
 * `run()`, where an author can order it against migrations and other start-up
 * work, and where a child that is never started never runs.
 */
export class Instance implements TextChannel {
  private run_?: RuntimeRun;
  private releaseHold?: () => void;
  private exited = false;
  /** Set by {@link openOutput}, which a reader calls when it is created — before
   *  the child starts. Absent means nobody reads, and nothing is retained. */
  private reader?: OutputQueue;

  constructor(
    private readonly resource: InstanceResource,
    private readonly ctx: ResourceContext,
  ) {}

  /**
   * Hand the child's output to the one resource that reads it.
   *
   * Called at the reader's creation, which is before this resource runs, so the
   * child's first prompt is retained rather than lost to a reader that attached
   * after the child had already printed it.
   */
  openOutput(): Stream<string> {
    if (this.reader) {
      throw new Error(
        `App.Instance "${this.resource.metadata.name}" is already being read. Two readers ` +
          `of one channel take each other's text, so which one saw a given line would ` +
          `depend on scheduling — declare one reader and invoke it from each step.`,
      );
    }
    this.reader = new OutputQueue();
    return this.reader.stream;
  }

  /** The child's input. Writing before the child has started, or after it has
   *  gone, says so rather than dropping the text. */
  readonly input: TextChannelInput = {
    write: async (text: string) => {
      const run = this.requireRunning("write to");
      await run.stdin.write(text);
    },
    end: async () => {
      // Ending input on a child that never started is what a caller means by
      // "no more input is coming", so it is not an error.
      await this.run_?.stdin.end();
    },
  };

  private requireRunning(action: string): RuntimeRun {
    if (!this.run_) {
      throw new InvokeError(
        "ERR_CHANNEL_NOT_STARTED",
        `App.Instance "${this.resource.metadata.name}" has not started, so there is nothing ` +
          `to ${action}. List it under the sequence's \`targets:\` before the steps that ` +
          `talk to it.`,
      );
    }
    if (this.exited) {
      throw new InvokeError(
        "ERR_CHANNEL_CLOSED",
        `App.Instance "${this.resource.metadata.name}" has exited, so there is nothing to ` +
          `${action}.`,
        { side: "input" },
      );
    }
    return this.run_;
  }

  run() {
    return this.ctx
      .effect("kernel hold", async () => {
        this.releaseHold = this.ctx.acquireHold(`application ${this.resource.metadata.name}`);
        return { result: undefined, inverse: () => this.release() };
      })
      .effect("running application", async () => {
        await this.start();
        return { result: undefined, inverse: () => this.stop() };
      });
  }

  private async start(): Promise<void> {
    const source = await this.resolveSource();
    const run = await this.ctx.runtime.run(source, {
      inputs: {
        variables: this.resource.variables,
        secrets: this.resource.secrets,
        ports: this.resource.ports,
      },
    });
    this.run_ = run;

    // Both streams are drained for as long as the child lives: an unread stream
    // accumulates in this process's memory, and a child that dies mid-test must
    // leave its reason in the parent's output rather than being diagnosed from
    // the connection error it causes downstream.
    // Only stdout is conversational. A Telo child writes its structured records
    // to stderr, so a reader matching on a merged stream would match inside a
    // JSON log line; stderr stays the diagnostic side and is forwarded alone.
    void this.forward(run.stdout, this.ctx.stdout, this.reader);
    void this.forward(run.stderr, this.ctx.stderr);

    // Null rather than nothing: `status.exitCode` is readable from the moment
    // the child is up, so a step reads "still running" instead of failing
    // because no reading has been reported yet.
    await this.ctx.setStatus({ exitCode: null });

    void run.exitCode.then((code) => this.onExit(code)).catch(() => {
      // `exitCode` settles rather than rejects — a child that fails to load
      // reports a non-zero code. Nothing to recover here.
    });

    // Waiting for the child's targets to be dispatched is what lets the next
    // step reach a server it declares without retrying. A child that blocks on
    // input never gets there, so it declares `awaitStart: false` and the
    // conversation's own markers order what follows. DECLARED rather than
    // inferred from whether anything reads the channel: a test that asserts on a
    // server child's log AND calls its port reads it too, and would have lost
    // the guarantee with nothing in the manifest to point at.
    if (this.resource.awaitStart !== false) await run.started;
  }

  /**
   * The child has finished on its own.
   *
   * Reporting the code is all this does. Whether an exit is a failure is the
   * author's claim, not this kind's — a supervisor of one-shot children expects
   * it, a test asserting on a server does not — so it is read from
   * `status.exitCode` rather than decided here.
   *
   * The hold is released for the same reason a schedule with no further
   * occurrences releases early: a child that has exited is no longer a reason
   * for this application to stay up.
   */
  private async onExit(code: number): Promise<void> {
    this.exited = true;
    this.ctx.log.info("The application exited", {
      "app.source": this.resource.source,
      "app.exit_code": code,
    });
    try {
      await this.ctx.setStatus({ exitCode: code });
    } catch {
      // A status reported while the kernel is already tearing this resource
      // down has nowhere to go; the exit is in the log either way.
    }
    this.release();
  }

  /**
   * A child's output goes to the parent's matching stream **verbatim**.
   *
   * Not re-emitted as log records: a Telo child already writes structured
   * records to stderr, so wrapping each line in a record of this application's
   * own produced JSON nested inside JSON — the reader lost the child's severity,
   * resource and event name to gain the wrapper. Passing bytes through keeps one
   * format on the channel, which is what a log consumer reading both is set up
   * for, and keeps a child's plain stdout plain.
   */
  private async forward(
    stream: Stream<string>,
    to: NodeJS.WritableStream,
    reader?: OutputQueue,
  ): Promise<void> {
    for await (const chunk of stream) {
      to.write(chunk);
      // A tee: the parent keeps seeing everything the child writes, which is how
      // a child that dies mid-conversation is diagnosed, while the reader gets
      // its own copy to match on. AWAITED, because the reader stops taking
      // chunks while its own buffer is full — draining this stream regardless
      // would pile them up here instead, defeating the back-pressure the seam
      // builds and growing the supervisor's heap on a chatty child.
      if (reader) await reader.push(chunk);
    }
    reader?.end();
  }

  /** Idempotent — `acquireHold` hands back a closure that ignores a second call,
   *  so a child that exits early and a teardown that follows are one release. */
  private release(): void {
    this.releaseHold?.();
  }

  /** The inverse of starting: stop the child and wait until it has torn down, so
   *  this application never outlives a child still holding its ports. A child
   *  that already exited is unaffected — `cancel()` is idempotent and safe after
   *  the fact. */
  private async stop(): Promise<void> {
    if (!this.run_ || this.exited) return;
    await this.run_.cancel(`application ${this.resource.metadata.name} torn down`);
  }

  private async resolveSource(): Promise<string> {
    const source = this.resource.source;
    if (!isModuleRelative(source)) return source;
    // A path the author wrote is relative to the module that declared this
    // resource, which is what `resolveModuleFile` knows and what a derived
    // directory would get wrong for a published module.
    const uri = await this.ctx.resolveModuleFile(source);
    return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  }

  snapshot(): Record<string, unknown> {
    return { source: this.resource.source };
  }
}

/**
 * The reader's copy of the child's output: chunks in, a {@link Stream} out.
 *
 * {@link push} resolves only once the chunk has been taken, so a reader that
 * stops consuming stops this queue, which stops the seam's channel, which stops
 * the child — one chain of back-pressure from the program to whoever reads it,
 * rather than an unbounded array in the middle of it.
 */
class OutputQueue {
  #pending?: { text: string; taken: () => void };
  #waiters: Array<(result: IteratorResult<string>) => void> = [];
  #ended = false;

  readonly stream: Stream<string> = new Stream<string>({
    [Symbol.asyncIterator]: () => ({ next: () => this.#next() }),
  });

  async push(text: string): Promise<void> {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: text, done: false });
      return;
    }
    await new Promise<void>((resolve) => {
      this.#pending = { text, taken: resolve };
    });
  }

  end(): void {
    this.#ended = true;
    // Release a producer still waiting for its chunk to be taken: nobody is
    // going to take it, and leaving it awaiting would hang the forwarder.
    this.#pending?.taken();
    this.#pending = undefined;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()!({ value: undefined, done: true });
    }
  }

  async #next(): Promise<IteratorResult<string>> {
    const pending = this.#pending;
    if (pending) {
      this.#pending = undefined;
      pending.taken();
      return { value: pending.text, done: false };
    }
    if (this.#ended) return { value: undefined, done: true };
    return new Promise<IteratorResult<string>>((resolve) => this.#waiters.push(resolve));
  }
}

export const schema = { type: "object", additionalProperties: true };

export async function create(
  resource: InstanceResource,
  ctx: ResourceContext,
): Promise<Instance> {
  return new Instance(resource, ctx);
}

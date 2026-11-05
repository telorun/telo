import {
  isCancellationError,
  isInvokeError,
  type InvokeContext,
  type Logger,
  type OpenSpan,
} from "@telorun/sdk";
import { decodeBroadcastPayload } from "./broadcast-payload.js";
import { topicMatches } from "./topic-grammar.js";

export const ERR_BROADCAST_MESSAGE_INVALID = "ERR_BROADCAST_MESSAGE_INVALID";
export const ERR_BROADCAST_HANDLER_FAILED = "ERR_BROADCAST_HANDLER_FAILED";

export interface SubscriptionPolicy {
  /** Patterns a message's topic must match one of; absent receives everything. */
  readonly topics?: readonly string[];
  readonly concurrency: number;
  readonly buffer: number;
}

/** Why a message or a hook failed: the failure's own code when it carries one. */
export interface BroadcastFailure {
  readonly code: string;
  readonly message: string;
  readonly data?: unknown;
}

export interface SubscriptionHost {
  readonly log: Logger;
  /** The message a decoded payload holds, held to the channel's `messageType`. */
  validate(message: unknown): { ok: true; message: unknown } | { ok: false; reason: string };
  openSpan(label: string, attributes: Record<string, unknown>): Promise<OpenSpan>;
  runHandler(topic: string | null, message: unknown, invokeCtx: InvokeContext): Promise<unknown>;
  /** Absent when the manifest wrote no `onError`. */
  runOnError?(
    failure: BroadcastFailure,
    topic: string | null,
    message: unknown,
    invokeCtx: InvokeContext,
  ): Promise<unknown>;
  /** Absent when the manifest wrote no `onGap`. */
  runOnGap?(reason: string, invokeCtx: InvokeContext): Promise<unknown>;
}

/** What waits for, or holds, a handler slot: a message to handle, or a received
 *  payload to report as no message of the channel. */
type Entry =
  | { readonly kind: "message"; readonly topic: string | null; readonly message: unknown }
  | { readonly kind: "invalid"; readonly reason: string; readonly topic: string | null; readonly message: unknown };

/**
 * One subscription's delivery: matches each payload against the topic patterns,
 * holds it to the message type, and runs the handler at most `concurrency` at a
 * time, queueing at most `buffer`. A full buffer drops its backlog and the
 * message that found it full, and raises a gap. A failure — the handler's, or a
 * message that is no message of the channel — is reported inside the slot that
 * delivered it, so reports are bounded like handlers, and never stops the loop.
 */
export class SubscriptionLoop {
  private readonly queue: Entry[] = [];
  private readonly pending = new Set<Promise<void>>();
  private running = 0;
  private stopped = false;

  constructor(
    private readonly label: string,
    private readonly policy: SubscriptionPolicy,
    private readonly host: SubscriptionHost,
  ) {}

  receive(payload: string): void {
    if (this.stopped) return;
    const decoded = decodeBroadcastPayload(payload);
    if (!decoded.ok) {
      this.admit({
        kind: "invalid",
        reason: `the payload is not a broadcast message: ${decoded.reason}`,
        topic: null,
        message: null,
      });
      return;
    }
    const { topic } = decoded;
    if (!this.wants(topic)) return;
    const checked = this.host.validate(decoded.message);
    if (!checked.ok) {
      this.admit({
        kind: "invalid",
        reason: `the message does not have the channel's message type: ${checked.reason}`,
        topic,
        message: decoded.message,
      });
      return;
    }
    this.admit({ kind: "message", topic, message: checked.message });
  }

  private admit(entry: Entry): void {
    if (this.running < this.policy.concurrency) {
      this.start(entry);
    } else if (this.queue.length < this.policy.buffer) {
      this.queue.push(entry);
    } else {
      const dropped = this.queue.length + 1;
      this.queue.length = 0;
      this.gap(`the buffer of ${this.policy.buffer} messages overflowed and ${dropped} were dropped`);
    }
  }

  gap(reason: string): void {
    if (this.stopped) return;
    const run = this.host.runOnGap;
    if (!run) {
      this.host.log.warn(`${this.label}: messages may have been missed — ${reason}`, {
        "telo.broadcast.gap": reason,
      });
      return;
    }
    this.track(
      this.guarded("gap", { "telo.broadcast.gap": reason }, (ctx) => run(reason, ctx)).then((failure) => {
        if (failure) this.logHookFailure("onGap", failure);
      }),
    );
  }

  /** Stop receiving, drop what is queued and wait for what is running. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private wants(topic: string | null): boolean {
    const { topics } = this.policy;
    if (topics === undefined) return true;
    return topic !== null && topics.some((pattern) => topicMatches(pattern, topic));
  }

  private start(entry: Entry): void {
    this.running++;
    this.track(
      this.deliver(entry)
        .catch((err: unknown) => this.unexpected(err))
        .finally(() => {
          this.running--;
          const next = this.queue.shift();
          if (next && !this.stopped) this.start(next);
        }),
    );
  }

  private async deliver(entry: Entry): Promise<void> {
    const attributes = entry.topic === null ? {} : { "telo.broadcast.topic": entry.topic };
    if (entry.kind === "invalid") {
      const failure: BroadcastFailure = { code: ERR_BROADCAST_MESSAGE_INVALID, message: entry.reason };
      const span = await this.host.openSpan("receive", attributes);
      await span.settle("failed", { attributes: { "error.type": failure.code } });
      await this.reportFailure(failure, entry.topic, entry.message);
      return;
    }
    const failure = await this.guarded("deliver", attributes, (ctx) =>
      this.host.runHandler(entry.topic, entry.message, ctx),
    );
    if (failure) await this.reportFailure(failure, entry.topic, entry.message);
  }

  /** Run `work` under a span — recorded as failed when it throws — and return the
   *  failure rather than throwing. */
  private async guarded(
    label: string,
    attributes: Record<string, unknown>,
    work: (ctx: InvokeContext) => Promise<unknown>,
  ): Promise<BroadcastFailure | undefined> {
    let span: OpenSpan | undefined;
    try {
      span = await this.host.openSpan(label, attributes);
      await work(span.context);
      await span.settle("ok");
      return undefined;
    } catch (err) {
      if (isCancellationError(err) && this.stopped) {
        await span?.settle("cancelled");
        return undefined;
      }
      const failure = failureOf(err);
      await span?.settle("failed", { attributes: { "error.type": failure.code } });
      return failure;
    }
  }

  /** Log the failure at error level with its code, then run `onError` and wait for it. */
  private async reportFailure(failure: BroadcastFailure, topic: string | null, message: unknown): Promise<void> {
    this.host.log.error(`${this.label}: [${failure.code}] ${failure.message}`, {
      "telo.broadcast.error.code": failure.code,
      ...(topic === null ? {} : { "telo.broadcast.topic": topic }),
    });
    const run = this.host.runOnError;
    if (!run) return;
    const hook = await this.guarded("error", { "telo.broadcast.error.code": failure.code }, (ctx) =>
      run(failure, topic, message, ctx),
    );
    if (hook) this.logHookFailure("onError", hook);
  }

  private logHookFailure(hook: "onGap" | "onError", failure: BroadcastFailure): void {
    this.host.log.error(`${this.label}: ${hook} failed [${failure.code}] — ${failure.message}`, {
      "telo.broadcast.error.code": failure.code,
    });
  }

  private unexpected(err: unknown): void {
    this.host.log.error(`${this.label}: reporting a failure failed unexpectedly`, {}, { error: err });
  }

  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }
}

function failureOf(err: unknown): BroadcastFailure {
  if (isInvokeError(err)) {
    return { code: err.code, message: err.message, ...(err.data === undefined ? {} : { data: err.data }) };
  }
  const code = (err as { code?: unknown } | null)?.code;
  return {
    code: typeof code === "string" ? code : ERR_BROADCAST_HANDLER_FAILED,
    message: err instanceof Error ? err.message : String(err),
  };
}

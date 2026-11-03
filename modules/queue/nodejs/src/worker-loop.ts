import {
  celDurationFromNanos,
  deriveContext,
  InvokeError,
  isCelDuration,
  isRetryable,
  retryBackoffMs,
  type CancellationSource,
  type CelDuration,
  type CelTimestamp,
  type InvokeContext,
  type InvokeStepRetry,
  type Logger,
  type OpenSpan,
  type SpanOutcome,
} from "@telorun/sdk";
import type { DecodedMessage } from "./queue-operation.js";
import type { ClaimedMessage, QueueError, QueueStore, SettleOutcome } from "./queue-store-contract.js";

export const ERR_QUEUE_TIMEOUT = "ERR_QUEUE_TIMEOUT";
export const ERR_QUEUE_LEASE_EXPIRED = "ERR_QUEUE_LEASE_EXPIRED";

/** How often an idle worker asks for work: from the first, doubling to the last. */
const IDLE_POLL_MS = { first: 50, max: 1_000 };
/** How a worker backs off a store that fails: from the first, doubling to the last. */
const OUTAGE_BACKOFF_MS = { first: 250, max: 30_000 };
/** How long a handler cancelled at shutdown, after its message was handed back,
 *  is waited for before the worker stops without it. */
export const SHUTDOWN_CANCEL_GRACE_MS = 1_000;

/** A local clock that never goes back, for measuring how long a lease is held. */
const monotonicMs = (): number => performance.now();

/** This delivery of a message, as the handler and the dead-letter handler see it. */
export interface Delivery {
  readonly messageId: string;
  readonly attempt: number;
  readonly enqueuedAt: CelTimestamp;
}

/** The worker's declared configuration, read once at creation. */
export interface WorkerPolicy {
  readonly concurrency: number;
  readonly lease: CelDuration;
  readonly leaseMs: number;
  readonly timeoutMs: number;
  readonly shutdownGraceMs: number;
  readonly retry: InvokeStepRetry & { attempts: number };
}

/** What the loop needs from its runtime. The controller supplies it from the
 *  resource context; the unit tests supply a fake. */
export interface WorkerHost {
  readonly store: QueueStore;
  readonly log: Logger;
  read(message: ClaimedMessage): DecodedMessage;
  createCancellationSource(): CancellationSource;
  /** A root context, cancelled with `cancellation` when one is given. */
  rootContext(cancellation?: CancellationSource): InvokeContext;
  /** The delivery span, continuing the trace the message was enqueued in. */
  openSpan(message: ClaimedMessage): Promise<OpenSpan>;
  runHandler(delivery: Delivery, message: unknown, ctx: InvokeContext): Promise<unknown>;
  /** Absent when the worker declares no `onDead`. */
  readonly runOnDead?: (
    delivery: Delivery,
    message: unknown,
    error: QueueError,
    ctx: InvokeContext,
  ) => Promise<unknown>;
  /** What the retry policy's `retryAfter` asks to wait after `err`, in ms, or
   *  undefined to keep the computed backoff. */
  retryAfterMs(err: unknown): number | undefined;
  /** In [0, 1): picks a jittered backoff. */
  random(): number;
}

type Ending = "lost" | "cancelled" | "shutdown";

/** One claimed message while this process holds it. */
class InFlight {
  /** Why the delivery stopped from outside: the lease was lost, the message
   *  was cancelled, or the worker is shutting down. First cause wins. */
  ending: Ending | undefined;
  /** Released at shutdown: nothing more may be settled through the claim. */
  handedBack = false;
  private current: CancellationSource | undefined;
  readonly done: Promise<void>;
  private finish!: () => void;

  /** The local instant (monotonic ms) the lease is known held until: the start
   *  of the claim or renewal the store last confirmed, plus the lease. */
  heldUntil: number;

  constructor(
    readonly message: ClaimedMessage,
    claimedAt: number,
    leaseMs: number,
  ) {
    this.heldUntil = claimedAt + leaseMs;
    this.done = new Promise((resolve) => (this.finish = resolve));
  }

  get delivery(): Delivery {
    return {
      messageId: this.message.id,
      attempt: this.message.attempt,
      enqueuedAt: this.message.enqueuedAt,
    };
  }

  stop(reason: Ending): void {
    this.ending ??= reason;
    this.current?.cancel(`queue delivery ${reason}`);
  }

  running(source: CancellationSource | undefined): void {
    this.current = source;
    if (source && this.ending) source.cancel(`queue delivery ${this.ending}`);
  }

  settled(): void {
    this.finish();
  }
}

type RunResult = { ok: true } | { ok: false; error: unknown };

/**
 * Queue.Worker's delivery loop: claims while there is room, runs each
 * message's handler under a renewed lease and a per-attempt timeout, and
 * settles it — completed, re-attempted after a backoff stored as a visibility
 * time, or dead-lettered after `onDead` ran. Every decision is made here, once
 * for every backend; the store only stores.
 */
export class WorkerLoop {
  private readonly inFlight = new Map<string, InFlight>();
  private stopping = false;
  private loopDone: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private readonly claimSource: CancellationSource;

  constructor(
    private readonly label: string,
    private readonly policy: WorkerPolicy,
    private readonly host: WorkerHost,
  ) {
    this.claimSource = host.createCancellationSource();
  }

  /** Start claiming. */
  start(): void {
    this.loopDone ??= this.loop();
  }

  /**
   * Stop claiming, let what is in flight finish for up to `shutdownGrace`, then
   * cancel what is left and hand each back with its attempt not counted.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.claimSource.cancel("queue worker stopping");
    this.wake?.();
    await this.loopDone;
    const pending = [...this.inFlight.values()];
    if (pending.length === 0) return;
    const finished = Promise.all(pending.map((flight) => flight.done)).then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.policy.shutdownGraceMs);
    });
    const allFinished = await Promise.race([finished, graceOver]);
    clearTimeout(timer);
    if (allFinished) return;
    const leftover = [...this.inFlight.values()];
    await Promise.all(
      leftover.map(async (flight) => {
        flight.stop("shutdown");
        flight.handedBack = true;
        await this.settle(flight, "hand back", (ctx) =>
          this.host.store.release(
            flight.message.claim,
            { visibleAfter: durationOfMs(0), error: null, giveBack: true },
            ctx,
          ),
        );
      }),
    );
    // The handlers were cancelled: wait for them to return, so none keeps
    // running against resources about to be torn down — bounded, since a
    // handler may ignore its cancellation.
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const returned = await Promise.race([
      Promise.all(leftover.map((flight) => flight.done)).then(() => true),
      new Promise<false>((resolve) => {
        cancelTimer = setTimeout(() => resolve(false), SHUTDOWN_CANCEL_GRACE_MS);
      }),
    ]);
    clearTimeout(cancelTimer);
    if (!returned) {
      const still = leftover.filter((flight) => this.inFlight.has(flight.message.claim));
      this.host.log.warn(
        `${this.label}: ${still.length} handler(s) did not return within ${SHUTDOWN_CANCEL_GRACE_MS}ms ` +
          `of being cancelled at shutdown; the worker stops without them. Their messages were ` +
          `handed back and will be delivered again.`,
        { "telo.queue.message.id": still.map((flight) => flight.message.id).join(",") },
      );
    }
  }

  private async loop(): Promise<void> {
    let idleMs = 0;
    let failures = 0;
    while (!this.stopping) {
      const room = this.policy.concurrency - this.inFlight.size;
      if (room <= 0) {
        await this.pause();
        continue;
      }
      let claimed: readonly ClaimedMessage[];
      // Taken before the call, so a lease is never thought to last longer than
      // the store granted it.
      const claimedAt = monotonicMs();
      try {
        const outcome = await this.host.store.claim(
          { limit: room, lease: this.policy.lease },
          this.host.rootContext(this.claimSource),
        );
        claimed = outcome.messages;
      } catch (err) {
        if (this.stopping) return;
        failures++;
        const backoff = Math.min(OUTAGE_BACKOFF_MS.max, OUTAGE_BACKOFF_MS.first * 2 ** (failures - 1));
        this.host.log.warn(
          `${this.label}: claiming from the queue failed; trying again in ${backoff}ms`,
          { "telo.queue.claim.failures": failures },
          { error: err },
        );
        await this.pause(backoff);
        continue;
      }
      if (failures > 0) {
        this.host.log.info(`${this.label}: claiming from the queue works again`, {
          "telo.queue.claim.failures": failures,
        });
        failures = 0;
      }
      if (claimed.length === 0) {
        idleMs = idleMs === 0 ? IDLE_POLL_MS.first : Math.min(IDLE_POLL_MS.max, idleMs * 2);
        await this.pause(idleMs);
        continue;
      }
      idleMs = 0;
      if (this.stopping) {
        // Claimed while the worker was stopping: handed straight back unrun.
        await Promise.all(claimed.map((message) => this.handBackUnrun(message)));
        return;
      }
      for (const message of claimed) this.begin(message, claimedAt);
    }
  }

  private async handBackUnrun(message: ClaimedMessage): Promise<void> {
    const flight = new InFlight(message, monotonicMs(), this.policy.leaseMs);
    flight.handedBack = true;
    await this.settle(flight, "hand back", (ctx) =>
      this.host.store.release(
        message.claim,
        { visibleAfter: durationOfMs(0), error: null, giveBack: true },
        ctx,
      ),
    );
  }

  /** Wait until woken — a delivery finished, or the worker is stopping — or
   *  until `ms` has passed. */
  private pause(ms?: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === undefined ? undefined : setTimeout(done, ms);
      const self = this;
      function done(): void {
        if (timer) clearTimeout(timer);
        if (self.wake === done) self.wake = undefined;
        resolve();
      }
      this.wake = done;
    });
  }

  private begin(message: ClaimedMessage, claimedAt: number): void {
    const flight = new InFlight(message, claimedAt, this.policy.leaseMs);
    this.inFlight.set(message.claim, flight);
    void this.deliver(flight).finally(() => {
      this.inFlight.delete(message.claim);
      flight.settled();
      this.wake?.();
    });
  }

  private async deliver(flight: InFlight): Promise<void> {
    const renewal = this.renewLease(flight);
    let span: OpenSpan | undefined;
    let outcome: SpanOutcome = "failed";
    try {
      span = await this.host.openSpan(flight.message);
      outcome = await this.process(flight, span.context);
    } catch (err) {
      // Every expected failure is settled inside `process`; reaching here is a
      // defect of the loop or the host, and the claim lapses for redelivery.
      this.host.log.error(
        `${this.label}: delivering a message failed unexpectedly; it will be delivered again ` +
          `once its lease lapses`,
        this.attributes(flight),
        { error: err },
      );
    } finally {
      renewal.stop();
      await span?.settle(outcome);
    }
  }

  private async process(flight: InFlight, base: InvokeContext): Promise<SpanOutcome> {
    const { message } = flight;
    const decoded = this.host.read(message);
    const value = decoded.ok ? decoded.message : null;
    if (message.dying) return this.dead(flight, base, value, message.dying);
    if (!decoded.ok) return this.dead(flight, base, null, decoded.error);
    if (message.lapsed) {
      const lapse: QueueError = {
        code: ERR_QUEUE_LEASE_EXPIRED,
        message: `The lease of attempt ${message.attempt - 1} lapsed before the message was settled.`,
      };
      if (message.attempt - 1 >= this.budget || !isRetryable(lapse, this.policy.retry.nonRetryable)) {
        return this.dead(flight, base, value, lapse);
      }
    }
    const run = await this.runBounded(flight, base, (ctx) => this.host.runHandler(flight.delivery, value, ctx));
    if (flight.ending) return "cancelled";
    if (run.ok) {
      await this.settle(flight, "complete", (ctx) => this.host.store.complete(message.claim, ctx));
      return "ok";
    }
    const failure = run.error;
    const error = queueErrorOf(failure);
    if (!isRetryable(failure, this.policy.retry.nonRetryable) || message.attempt >= this.budget) {
      return this.dead(flight, base, value, error);
    }
    const waitMs = this.retryWaitMs(flight, failure, message.attempt - 1);
    await this.settle(flight, "release", (ctx) =>
      this.host.store.release(
        message.claim,
        { visibleAfter: durationOfMs(waitMs), error, giveBack: false },
        ctx,
      ),
    );
    return "failed";
  }

  /** Every attempt the policy allows: the first and its re-attempts. */
  private get budget(): number {
    return 1 + this.policy.retry.attempts;
  }

  /**
   * Dead-letter: `onDead` runs first and the message is marked dead only once it
   * returned. One that fails hands the message back with a backoff, marked as
   * dying, so its next claim goes straight to `onDead` again.
   */
  private async dead(
    flight: InFlight,
    base: InvokeContext,
    value: unknown,
    error: QueueError,
  ): Promise<SpanOutcome> {
    const { message } = flight;
    const onDead = this.host.runOnDead;
    if (onDead) {
      const run = await this.runBounded(flight, base, (ctx) => onDead(flight.delivery, value, error, ctx));
      if (flight.ending) return "cancelled";
      if (!run.ok) {
        const waitMs = this.jittered(retryBackoffMs(this.policy.retry, message.attempt - 1));
        this.host.log.warn(
          `${this.label}: the dead-letter handler failed; the message is offered to it again in ` +
            `${Math.round(waitMs)}ms`,
          { ...this.attributes(flight), "error.type": error.code },
          { error: run.error },
        );
        await this.settle(flight, "release", (ctx) =>
          this.host.store.release(
            message.claim,
            { visibleAfter: durationOfMs(waitMs), error, giveBack: false, dying: error },
            ctx,
          ),
        );
        return "failed";
      }
    }
    const settled = await this.settle(flight, "kill", (ctx) => this.host.store.kill(message.claim, error, ctx));
    if (settled) {
      this.host.log.warn(`${this.label}: message dead-lettered — ${error.message}`, {
        ...this.attributes(flight),
        "error.type": error.code,
      });
    }
    return "failed";
  }

  /**
   * Run one handler call bounded by the attempt timeout, cancellable by the
   * delivery being stopped from outside. A timeout is the attempt's failure,
   * `ERR_QUEUE_TIMEOUT`, whether or not the handler honoured the cancellation.
   */
  private async runBounded(
    flight: InFlight,
    base: InvokeContext,
    call: (ctx: InvokeContext) => Promise<unknown>,
  ): Promise<RunResult> {
    const source = this.host.createCancellationSource();
    flight.running(source);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      source.cancel("queue attempt timeout");
    }, this.policy.timeoutMs);
    try {
      await call(deriveContext(base, { cancellation: source.token }));
      return timedOut && !flight.ending ? { ok: false, error: this.timeoutError(flight) } : { ok: true };
    } catch (err) {
      return { ok: false, error: timedOut && !flight.ending ? this.timeoutError(flight) : err };
    } finally {
      clearTimeout(timer);
      flight.running(undefined);
      source.dispose();
    }
  }

  private timeoutError(flight: InFlight): InvokeError {
    return new InvokeError(
      ERR_QUEUE_TIMEOUT,
      `${this.label}: attempt ${flight.message.attempt} of message '${flight.message.id}' ran ` +
        `longer than the worker's timeout of ${this.policy.timeoutMs}ms and was cancelled.`,
      { messageId: flight.message.id, attempt: flight.message.attempt },
    );
  }

  /** How long a failed attempt waits: what `retryAfter` asks, else the jittered
   *  backoff. A `retryAfter` that yields something other than a duration or
   *  null is reported and the backoff kept. */
  private retryWaitMs(flight: InFlight, failure: unknown, resend: number): number {
    try {
      const requested = this.host.retryAfterMs(failure);
      if (requested !== undefined) return requested;
    } catch (err) {
      this.host.log.error(
        `${this.label}: 'retry.retryAfter' could not be read; the computed backoff applies`,
        this.attributes(flight),
        { error: err },
      );
    }
    return this.jittered(retryBackoffMs(this.policy.retry, resend));
  }

  private jittered(backoffMs: number): number {
    return (this.policy.retry.jitter ?? "full") === "full" ? this.host.random() * backoffMs : backoffMs;
  }

  /**
   * Renew the lease every third of it while the delivery runs, and give the
   * message up locally before the lease could lapse. The lease is known held
   * until the start of the last renewal the store confirmed plus `lease`, on a
   * monotonic local clock; when a third of the lease is all that remains of
   * that — renewals failing, hanging, or the store unreachable — the handler is
   * cancelled as for a lost lease and nothing is settled, so this worker stops
   * before another may claim the message. Each renewal is bounded by the same
   * moment. A lost lease stops the handler; a cancel the store reports stops it
   * too — the store has settled the message `cancelled` already.
   */
  private renewLease(flight: InFlight): { stop(): void } {
    const margin = this.policy.leaseMs / 3;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = () => {
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(giveUp, Math.max(0, flight.heldUntil - margin - monotonicMs()));
    };
    const giveUp = () => {
      if (flight.ending || flight.handedBack) return;
      this.host.log.warn(
        `${this.label}: the lease on a message could not be renewed in time; the handler is ` +
          `cancelled before the lease lapses, and another consumer may deliver it`,
        this.attributes(flight),
      );
      flight.stop("lost");
    };
    let renewing = false;
    const renew = async () => {
      if (renewing || flight.ending || flight.handedBack) return;
      renewing = true;
      const startedAt = monotonicMs();
      const bound = flight.heldUntil - margin - startedAt;
      const source = this.host.createCancellationSource();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (bound <= 0) return;
        source.cancelAfter(bound);
        const outcome = await Promise.race([
          this.host.store.renew(flight.message.claim, this.policy.lease, this.host.rootContext(source)),
          new Promise<never>((resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`the renewal did not answer within ${Math.round(bound)}ms`)),
              bound,
            );
          }),
        ]);
        if (outcome.status === "held") {
          flight.heldUntil = startedAt + this.policy.leaseMs;
          armDeadline();
        } else if (outcome.status === "lost") {
          this.host.log.warn(
            `${this.label}: the lease on a message was lost while its handler ran; the handler is ` +
              `cancelled and another consumer may deliver it`,
            this.attributes(flight),
          );
          flight.stop("lost");
        } else if (outcome.status === "cancelled") {
          this.host.log.info(
            `${this.label}: a running message was cancelled; its handler is stopped`,
            this.attributes(flight),
          );
          flight.stop("cancelled");
        }
      } catch (err) {
        this.host.log.warn(
          `${this.label}: renewing a message's lease failed; trying again until a third of the ` +
            `lease remains`,
          this.attributes(flight),
          { error: err },
        );
      } finally {
        clearTimeout(timer);
        source.dispose();
        renewing = false;
      }
    };
    armDeadline();
    const interval = setInterval(() => void renew(), Math.max(1, this.policy.leaseMs / 3));
    return {
      stop: () => {
        clearInterval(interval);
        if (deadline) clearTimeout(deadline);
      },
    };
  }

  /** Settle through the claim unless it is no longer this delivery's. A store
   *  failure is reported; the lease then lapses and the message is delivered
   *  again. Answers whether the store settled it. */
  private async settle(
    flight: InFlight,
    what: string,
    call: (ctx: InvokeContext) => Promise<SettleOutcome>,
  ): Promise<boolean> {
    if (flight.ending === "lost" || flight.ending === "cancelled") return false;
    if (flight.handedBack && what !== "hand back") return false;
    try {
      const outcome = await call(this.host.rootContext());
      if (outcome.status === "lost") {
        this.host.log.warn(
          `${this.label}: could not ${what} a message — its claim was no longer held`,
          this.attributes(flight),
        );
        return false;
      }
      return true;
    } catch (err) {
      this.host.log.error(
        `${this.label}: could not ${what} a message — the store failed; it will be delivered ` +
          `again once its lease lapses`,
        this.attributes(flight),
        { error: err },
      );
      return false;
    }
  }

  private attributes(flight: InFlight): Record<string, string | number> {
    return {
      "telo.queue.message.id": flight.message.id,
      "telo.queue.delivery.attempt": flight.message.attempt,
    };
  }
}

/** A failure as it is recorded with a message: its code, message and data. */
export function queueErrorOf(err: unknown): QueueError {
  const failure = err as { code?: unknown; data?: unknown } | null | undefined;
  return {
    code: typeof failure?.code === "string" ? failure.code : "INTERNAL_ERROR",
    message: err instanceof Error ? err.message : String(err),
    ...(failure?.data === undefined || failure.data === null ? {} : { data: failure.data }),
  };
}

/** A wait in milliseconds as a duration. One outside CEL's duration range is
 *  refused: no configuration the module accepts produces one. */
export function durationOfMs(ms: number): CelDuration {
  const duration = celDurationFromNanos(BigInt(Math.max(0, Math.round(ms * 1_000_000))));
  if (!isCelDuration(duration)) {
    throw new RangeError(`A wait of ${ms}ms is outside the range of a duration.`);
  }
  return duration;
}

import {
  celTimestampFromMillis,
  createCancellationSource,
  durationNanos,
  InvokeError,
  NOOP_LOGGER,
  UNCANCELLABLE_CONTEXT,
  type CelDuration,
  type InvokeContext,
  type Logger,
} from "@telorun/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { DecodedMessage } from "../src/queue-operation.js";
import type {
  ClaimedMessage,
  QueueError,
  QueueSettings,
  QueueStore,
  ReleaseRequest,
} from "../src/queue-store-contract.js";
import { durationOfMs, SHUTDOWN_CANCEL_GRACE_MS, WorkerLoop, type Delivery, type WorkerHost, type WorkerPolicy } from "../src/worker-loop.js";

const ms = (duration: CelDuration) => Number(durationNanos(duration) / 1_000_000n);
const settled = { status: "settled" } as const;

/** A store that hands out the messages it is given, once each, and records
 *  every settlement. `renewals` answers each renewal in turn. */
class FakeStore implements QueueStore {
  readonly calls: Array<[string, ...unknown[]]> = [];
  claimFailures = 0;
  renewals: Array<"held" | "lost" | "cancelled" | "throw" | "hang"> = [];
  /** What every renewal past the scripted ones answers. */
  renewalsAfter: "held" | "throw" | "hang" = "held";

  constructor(private queue: ClaimedMessage[]) {}

  settings(): QueueSettings {
    return { messageType: { type: "object" }, maxMessageBytes: 1024 };
  }
  async enqueue() {
    return [];
  }
  async claim(request: { limit: number }) {
    if (this.claimFailures > 0) {
      this.claimFailures--;
      this.calls.push(["claim-failed"]);
      throw new Error("connection refused");
    }
    const messages = this.queue.splice(0, request.limit);
    if (messages.length > 0) this.calls.push(["claim", messages.map((m) => m.id)]);
    return { messages };
  }
  async renew(claim: string) {
    const status = this.renewals.shift() ?? this.renewalsAfter;
    this.calls.push(["renew", claim, status]);
    if (status === "throw") throw new Error("connection refused");
    if (status === "hang") return new Promise<never>(() => undefined);
    return { status };
  }
  async complete(claim: string) {
    this.calls.push(["complete", claim]);
    return settled;
  }
  async release(claim: string, release: ReleaseRequest) {
    this.calls.push(["release", claim, release]);
    return settled;
  }
  async kill(claim: string, error: QueueError) {
    this.calls.push(["kill", claim, error]);
    return settled;
  }
  async stats() {
    return { pending: 0, scheduled: 0, running: 0, dead: 0, oldestPendingAge: null, exact: true };
  }
  settlements() {
    return this.calls.filter(([what]) => what === "complete" || what === "release" || what === "kill");
  }
}

function claimed(overrides: Partial<ClaimedMessage> = {}): ClaimedMessage {
  return {
    id: "m1",
    claim: "c1",
    body: "{}",
    generation: 1,
    attempt: 1,
    enqueuedAt: celTimestampFromMillis(0),
    lapsed: false,
    ...overrides,
  };
}

const policy = (overrides: Partial<WorkerPolicy> = {}): WorkerPolicy => ({
  concurrency: 1,
  lease: durationOfMs(60),
  leaseMs: 60,
  timeoutMs: 1_000,
  shutdownGraceMs: 50,
  retry: { attempts: 2, initialDelay: 100, jitter: "none" },
  ...overrides,
});

interface Recorded {
  warnings: string[];
  handled: Array<{ delivery: Delivery; message: unknown }>;
  dead: Array<{ message: unknown; error: QueueError }>;
}

function host(
  store: FakeStore,
  behaviour: {
    handler?: (ctx: InvokeContext) => Promise<unknown>;
    onDead?: ((error: QueueError) => Promise<unknown>) | null;
    read?: (message: ClaimedMessage) => DecodedMessage;
    retryAfterMs?: (err: unknown) => number | undefined;
  } = {},
): { host: WorkerHost; recorded: Recorded } {
  const recorded: Recorded = { warnings: [], handled: [], dead: [] };
  const log: Logger = { ...NOOP_LOGGER, warn: (message: string) => void recorded.warnings.push(message) };
  const onDead = behaviour.onDead === undefined ? async () => undefined : behaviour.onDead;
  return {
    recorded,
    host: {
      store,
      log,
      read: behaviour.read ?? (() => ({ ok: true, message: { orderId: "o-1" } })),
      createCancellationSource,
      rootContext: (cancellation) => cancellation?.context ?? UNCANCELLABLE_CONTEXT,
      openSpan: async () => ({ context: UNCANCELLABLE_CONTEXT, settle: async () => undefined }),
      runHandler: async (delivery, message, ctx) => {
        recorded.handled.push({ delivery, message });
        return behaviour.handler?.(ctx);
      },
      ...(onDead === null
        ? {}
        : {
            runOnDead: async (delivery: Delivery, message: unknown, error: QueueError) => {
              recorded.dead.push({ message, error });
              return onDead(error);
            },
          }),
      retryAfterMs: behaviour.retryAfterMs ?? (() => undefined),
      random: () => 0.5,
    },
  };
}

/** Runs the loop until the store has settled `count` times, then stops it. */
async function runUntil(loop: WorkerLoop, store: FakeStore, count = 1): Promise<void> {
  loop.start();
  const deadline = Date.now() + 3_000;
  while (store.settlements().length < count) {
    if (Date.now() > deadline) throw new Error(`timed out; calls: ${JSON.stringify(store.calls)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await loop.stop();
}

const never = (ctx: InvokeContext) =>
  new Promise((resolve, reject) => {
    ctx.cancellation.onCancelled((reason) =>
      reject(new InvokeError("ERR_INVOKE_CANCELLED", reason ?? "cancelled")),
    );
  });

let loops: WorkerLoop[] = [];
afterEach(async () => {
  await Promise.all(loops.map((loop) => loop.stop()));
  loops = [];
});
function worker(store: FakeStore, h: WorkerHost, p: WorkerPolicy = policy()): WorkerLoop {
  const loop = new WorkerLoop("Queue.Worker \"test\"", p, h);
  loops.push(loop);
  return loop;
}

describe("Queue.Worker delivery outcomes", () => {
  it("completes a message whose handler returns, handing it the delivery", async () => {
    const store = new FakeStore([claimed()]);
    const { host: h, recorded } = host(store);
    await runUntil(worker(store, h), store);
    expect(store.settlements()).toEqual([["complete", "c1"]]);
    expect(recorded.handled[0]).toMatchObject({
      delivery: { messageId: "m1", attempt: 1 },
      message: { orderId: "o-1" },
    });
  });

  it("releases a retryable failure with attempts left after the backoff, recording the error", async () => {
    const store = new FakeStore([claimed({ attempt: 2 })]);
    const { host: h } = host(store, {
      handler: async () => {
        throw new InvokeError("ERR_UPSTREAM", "upstream down", { status: 503 });
      },
    });
    await runUntil(worker(store, h), store);
    const [[, claim, release]] = store.settlements() as [[string, string, ReleaseRequest]];
    expect(claim).toBe("c1");
    // Attempt 2 failed: the second re-attempt waits initialDelay × factor.
    expect(ms(release.visibleAfter)).toBe(200);
    expect(release).toMatchObject({
      giveBack: false,
      error: { code: "ERR_UPSTREAM", message: "upstream down", data: { status: 503 } },
    });
  });

  it("waits what retryAfter asks instead of the backoff", async () => {
    const store = new FakeStore([claimed()]);
    const { host: h } = host(store, {
      handler: async () => {
        throw new InvokeError("ERR_RATE_LIMITED", "slow down");
      },
      retryAfterMs: () => 7_000,
    });
    await runUntil(worker(store, h), store);
    const [[, , release]] = store.settlements() as [[string, string, ReleaseRequest]];
    expect(ms(release.visibleAfter)).toBe(7_000);
  });

  it("dead-letters a non-retryable code after onDead ran, logging one warning", async () => {
    const store = new FakeStore([claimed()]);
    const { host: h, recorded } = host(store, {
      handler: async () => {
        throw new InvokeError("ERR_PAYMENT_DECLINED", "declined");
      },
    });
    await runUntil(worker(store, h, policy({ retry: { attempts: 5, nonRetryable: ["ERR_PAYMENT_DECLINED"] } })), store);
    expect(recorded.dead).toEqual([
      { message: { orderId: "o-1" }, error: { code: "ERR_PAYMENT_DECLINED", message: "declined" } },
    ]);
    expect(store.settlements()).toEqual([
      ["kill", "c1", { code: "ERR_PAYMENT_DECLINED", message: "declined" }],
    ]);
    expect(recorded.warnings.filter((w) => w.includes("dead-lettered"))).toHaveLength(1);
  });

  it("dead-letters a failure of the last allowed attempt", async () => {
    const store = new FakeStore([claimed({ attempt: 3 })]);
    const { host: h } = host(store, {
      handler: async () => {
        throw new InvokeError("ERR_UPSTREAM", "down");
      },
    });
    await runUntil(worker(store, h), store);
    expect(store.settlements()).toEqual([["kill", "c1", { code: "ERR_UPSTREAM", message: "down" }]]);
  });

  it("dead-letters a contract violation at once, whatever attempts are left", async () => {
    const store = new FakeStore([claimed()]);
    const { host: h } = host(store, {
      handler: async () => {
        throw new InvokeError("ERR_INPUT_INVALID", "bad inputs");
      },
    });
    await runUntil(worker(store, h), store);
    expect(store.settlements()[0]?.[0]).toBe("kill");
  });

  it("cancels an attempt that overruns its timeout and records ERR_QUEUE_TIMEOUT", async () => {
    const store = new FakeStore([claimed()]);
    let cancelled = false;
    const { host: h } = host(store, {
      handler: (ctx) => {
        ctx.cancellation.onCancelled(() => (cancelled = true));
        return never(ctx);
      },
    });
    await runUntil(worker(store, h, policy({ timeoutMs: 20 })), store);
    expect(cancelled).toBe(true);
    const [[what, , release]] = store.settlements() as [[string, string, ReleaseRequest]];
    expect(what).toBe("release");
    expect(release.error?.code).toBe("ERR_QUEUE_TIMEOUT");
  });

  it("dead-letters without running the handler when a lapsed lease used up the budget", async () => {
    const store = new FakeStore([claimed({ attempt: 4, lapsed: true })]);
    const { host: h, recorded } = host(store);
    await runUntil(worker(store, h), store);
    expect(recorded.handled).toHaveLength(0);
    expect(recorded.dead[0]?.error.code).toBe("ERR_QUEUE_LEASE_EXPIRED");
    expect(store.settlements()[0]?.[0]).toBe("kill");
  });

  it("runs the handler again after a lapsed lease while the budget lasts", async () => {
    const store = new FakeStore([claimed({ attempt: 2, lapsed: true })]);
    const { host: h, recorded } = host(store);
    await runUntil(worker(store, h), store);
    expect(recorded.handled).toHaveLength(1);
    expect(store.settlements()).toEqual([["complete", "c1"]]);
  });

  it("cancels the handler and settles nothing when the lease is lost", async () => {
    const store = new FakeStore([claimed()]);
    store.renewals = ["lost"];
    let cancelled = false;
    const { host: h } = host(store, {
      handler: (ctx) => {
        ctx.cancellation.onCancelled(() => (cancelled = true));
        return never(ctx);
      },
    });
    const loop = worker(store, h, policy({ leaseMs: 15, lease: durationOfMs(15) }));
    loop.start();
    await expectEventually(() => cancelled);
    await loop.stop();
    expect(store.settlements()).toEqual([]);
  });

  for (const failure of ["throw", "hang"] as const) {
    it(`gives the message up before its lease lapses when renewals ${failure === "throw" ? "fail" : "hang"}`, async () => {
      const store = new FakeStore([claimed()]);
      store.renewalsAfter = failure;
      let cancelledAfterMs: number | undefined;
      const started = performance.now();
      const { host: h, recorded } = host(store, {
        handler: (ctx) => {
          ctx.cancellation.onCancelled(() => (cancelledAfterMs = performance.now() - started));
          return never(ctx);
        },
      });
      const loop = worker(store, h, policy({ leaseMs: 60, lease: durationOfMs(60) }));
      loop.start();
      await expectEventually(() => cancelledAfterMs !== undefined);
      await loop.stop();
      // Given up with a third of the lease left: never after the lease lapsed.
      expect(cancelledAfterMs).toBeLessThan(60);
      expect(store.settlements()).toEqual([]);
      expect(recorded.warnings.some((w) => w.includes("could not be renewed in time"))).toBe(true);
    });
  }

  it("cancels the handler when a cancel is seen at renewal, leaving the store's settlement alone", async () => {
    const store = new FakeStore([claimed()]);
    store.renewals = ["cancelled"];
    let cancelled = false;
    const { host: h, recorded } = host(store, {
      handler: (ctx) => {
        ctx.cancellation.onCancelled(() => (cancelled = true));
        return never(ctx);
      },
    });
    const loop = worker(store, h, policy({ leaseMs: 15, lease: durationOfMs(15) }));
    loop.start();
    await expectEventually(() => cancelled);
    await loop.stop();
    expect(store.settlements()).toEqual([]);
    expect(recorded.dead).toHaveLength(0);
  });

  it("hands an unfinished delivery back at shutdown, its attempt not counted", async () => {
    const store = new FakeStore([claimed()]);
    let cancelled = false;
    const { host: h } = host(store, {
      handler: (ctx) => {
        ctx.cancellation.onCancelled(() => (cancelled = true));
        return never(ctx);
      },
    });
    const loop = worker(store, h, policy({ shutdownGraceMs: 20 }));
    loop.start();
    await expectEventually(() => store.calls.some(([what]) => what === "claim"));
    await loop.stop();
    expect(cancelled).toBe(true);
    expect(store.settlements()).toEqual([
      ["release", "c1", { visibleAfter: durationOfMs(0), error: null, giveBack: true }],
    ]);
  });

  it("waits a bounded time for a handler that ignores its cancellation at shutdown", async () => {
    const store = new FakeStore([claimed()]);
    const { host: h, recorded } = host(store, { handler: () => new Promise(() => undefined) });
    const loop = worker(store, h, policy({ shutdownGraceMs: 10 }));
    loop.start();
    await expectEventually(() => store.calls.some(([what]) => what === "claim"));
    const started = performance.now();
    await loop.stop();
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(SHUTDOWN_CANCEL_GRACE_MS);
    expect(waited).toBeLessThan(SHUTDOWN_CANCEL_GRACE_MS + 500);
    expect(store.settlements()).toEqual([
      ["release", "c1", { visibleAfter: durationOfMs(0), error: null, giveBack: true }],
    ]);
    expect(recorded.warnings.some((w) => w.includes("did not return within"))).toBe(true);
  });

  it("lets a delivery finish within the shutdown grace", async () => {
    const store = new FakeStore([claimed()]);
    const { host: h } = host(store, {
      handler: () => new Promise((resolve) => setTimeout(resolve, 20)),
    });
    const loop = worker(store, h, policy({ shutdownGraceMs: 500 }));
    loop.start();
    await expectEventually(() => store.calls.some(([what]) => what === "claim"));
    await loop.stop();
    expect(store.settlements()).toEqual([["complete", "c1"]]);
  });

  it("releases a message whose onDead failed, marked dying, after a backoff", async () => {
    const store = new FakeStore([claimed({ attempt: 3 })]);
    const { host: h } = host(store, {
      handler: async () => {
        throw new InvokeError("ERR_UPSTREAM", "down");
      },
      onDead: async () => {
        throw new Error("audit table missing");
      },
    });
    await runUntil(worker(store, h), store);
    const [[what, , release]] = store.settlements() as [[string, string, ReleaseRequest]];
    expect(what).toBe("release");
    expect(ms(release.visibleAfter)).toBe(400);
    expect(release.dying).toEqual({ code: "ERR_UPSTREAM", message: "down" });
  });

  it("goes straight to onDead for a dying message, without running the handler", async () => {
    const dying = { code: "ERR_UPSTREAM", message: "down" };
    const store = new FakeStore([claimed({ attempt: 4, dying })]);
    const { host: h, recorded } = host(store);
    await runUntil(worker(store, h), store);
    expect(recorded.handled).toHaveLength(0);
    expect(recorded.dead).toEqual([{ message: { orderId: "o-1" }, error: dying }]);
    expect(store.settlements()).toEqual([["kill", "c1", dying]]);
  });

  it("dead-letters a body that does not have the message type, onDead seeing a null message", async () => {
    const store = new FakeStore([claimed()]);
    const invalid = { code: "ERR_QUEUE_MESSAGE_INVALID", message: "missing orderId" };
    const { host: h, recorded } = host(store, { read: () => ({ ok: false, error: invalid }) });
    await runUntil(worker(store, h), store);
    expect(recorded.handled).toHaveLength(0);
    expect(recorded.dead).toEqual([{ message: null, error: invalid }]);
    expect(store.settlements()).toEqual([["kill", "c1", invalid]]);
  });

  it("keeps running through a store outage, backing off and recovering on its own", async () => {
    const store = new FakeStore([claimed()]);
    store.claimFailures = 2;
    const { host: h, recorded } = host(store);
    await runUntil(worker(store, h), store);
    expect(store.calls.filter(([what]) => what === "claim-failed")).toHaveLength(2);
    expect(store.settlements()).toEqual([["complete", "c1"]]);
    expect(recorded.warnings.filter((w) => w.includes("claiming from the queue failed"))).toHaveLength(2);
  });
});

async function expectEventually(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

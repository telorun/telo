import { NOOP_LOGGER, type InvokeContext, type OpenSpan } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { encodeBroadcastPayload } from "../src/broadcast-payload.js";
import { SubscriptionLoop, type SubscriptionHost } from "../src/subscription-loop.js";

const context = {} as InvokeContext;
const span: OpenSpan = { context, settle: async () => {} };

function host(overrides: Partial<SubscriptionHost> & { delivered: unknown[] }): SubscriptionHost {
  const { delivered, ...rest } = overrides;
  return {
    log: NOOP_LOGGER,
    validate: (message) =>
      typeof message === "object" && message !== null && "n" in message
        ? { ok: true, message }
        : { ok: false, reason: "no n" },
    openSpan: async () => span,
    runHandler: async (topic, message) => {
      delivered.push({ topic, message });
    },
    ...rest,
  };
}

const send = (loop: SubscriptionLoop, topic: string | null, message: unknown) =>
  loop.receive(encodeBroadcastPayload(topic, message));

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("SubscriptionLoop", () => {
  it("hands the handler the topic and the message of each match, in order", async () => {
    const delivered: unknown[] = [];
    const loop = new SubscriptionLoop("s", { topics: ["rooms.*"], concurrency: 1, buffer: 8 }, host({ delivered }));
    send(loop, "rooms.1", { n: 1 });
    send(loop, "rooms.1.typing", { n: 2 });
    send(loop, null, { n: 3 });
    send(loop, "rooms.2", { n: 4 });
    await tick();
    await loop.stop();
    expect(delivered).toEqual([
      { topic: "rooms.1", message: { n: 1 } },
      { topic: "rooms.2", message: { n: 4 } },
    ]);
  });

  it("reports a message that is not the channel's type as ERR_BROADCAST_MESSAGE_INVALID, runs no handler and keeps going", async () => {
    const delivered: unknown[] = [];
    const errors: unknown[] = [];
    const loop = new SubscriptionLoop(
      "s",
      { concurrency: 1, buffer: 8 },
      host({
        delivered,
        runOnError: async (failure, topic, message) => {
          errors.push({ code: failure.code, topic, message });
        },
      }),
    );
    send(loop, "a.b", { wrong: true });
    loop.receive("not json");
    send(loop, "a.b", { n: 1 });
    await tick();
    await loop.stop();
    expect(errors).toEqual([
      { code: "ERR_BROADCAST_MESSAGE_INVALID", topic: "a.b", message: { wrong: true } },
      { code: "ERR_BROADCAST_MESSAGE_INVALID", topic: null, message: null },
    ]);
    expect(delivered).toEqual([{ topic: "a.b", message: { n: 1 } }]);
  });

  it("drops its backlog and the message that found the buffer full, raises one gap, and handles what follows", async () => {
    const delivered: { message: { n: number } }[] = [];
    const gaps: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const loop = new SubscriptionLoop(
      "s",
      { concurrency: 1, buffer: 2 },
      host({
        delivered,
        runHandler: async (topic, message) => {
          delivered.push({ topic, message } as never);
          await held;
        },
        runOnGap: async (reason) => {
          gaps.push(reason);
        },
      }),
    );
    for (const n of [1, 2, 3, 4, 5]) send(loop, null, { n });
    release();
    await tick();
    await loop.stop();
    expect(gaps).toHaveLength(1);
    expect(delivered.map((entry) => entry.message.n)).toEqual([1, 5]);
  });

  it("runs at most `concurrency` handlers at once", async () => {
    let running = 0;
    let peak = 0;
    const loop = new SubscriptionLoop(
      "s",
      { concurrency: 2, buffer: 8 },
      host({
        delivered: [],
        runHandler: async () => {
          peak = Math.max(peak, ++running);
          await tick();
          running--;
        },
      }),
    );
    for (const n of [1, 2, 3, 4]) send(loop, null, { n });
    await tick();
    await tick();
    await loop.stop();
    expect(peak).toBe(2);
  });

  it("waits for onError inside the slot, so a slow hook holds back the next message", async () => {
    const order: string[] = [];
    const loop = new SubscriptionLoop(
      "s",
      { concurrency: 1, buffer: 8 },
      host({
        delivered: [],
        runHandler: async (_topic, message) => {
          order.push(`handle ${(message as { n: number }).n}`);
          throw new Error("boom");
        },
        runOnError: async () => {
          order.push("onError start");
          await tick();
          order.push("onError end");
        },
      }),
    );
    send(loop, null, { n: 1 });
    send(loop, null, { n: 2 });
    await tick();
    await tick();
    await loop.stop();
    expect(order).toEqual(["handle 1", "onError start", "onError end", "handle 2", "onError start", "onError end"]);
  });

  it("holds invalid-message reports to the buffer: an overflow drops them and raises a gap", async () => {
    const gaps: string[] = [];
    const reported: string[] = [];
    const loop = new SubscriptionLoop(
      "s",
      { concurrency: 1, buffer: 1 },
      host({
        delivered: [],
        runOnError: async (failure) => {
          reported.push(failure.code);
          await tick();
        },
        runOnGap: async (reason) => {
          gaps.push(reason);
        },
      }),
    );
    for (let i = 0; i < 4; i++) loop.receive("not json");
    await tick();
    await tick();
    await loop.stop();
    expect(gaps).toHaveLength(1);
    expect(reported).toHaveLength(2);
  });
});

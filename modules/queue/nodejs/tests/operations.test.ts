import {
  celTimestampFromMillis,
  InvokeError,
  NOOP_LOGGER,
  type InvokeContext,
  type ResourceContext,
} from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import * as Enqueue from "../src/enqueue-controller.js";
import * as EnqueueMany from "../src/enqueue-many-controller.js";
import * as List from "../src/list-controller.js";
import { bodyDigest, encodeMessageBody, parseMessageBody } from "../src/message-envelope.js";
import type { EnqueueOutcome, EnqueueRequest, ListRequest } from "../src/queue-store-contract.js";

const invocation = { cancellation: {} } as unknown as InvokeContext;

function context(carrier?: { traceparent: string; tracestate?: string }): ResourceContext {
  return {
    log: NOOP_LOGGER,
    resolveRef(value: unknown, guard: (candidate: unknown) => boolean, describe: () => string) {
      if (!guard(value)) throw new Error(`${describe()} is not a queue store`);
      return value;
    },
    traceCarrier: () => carrier,
  } as unknown as ResourceContext;
}

/** A plain-object store — nothing imported from the module — answering each
 *  enqueue with the outcomes it is given, or failing as its storage would. */
function store(answers: EnqueueOutcome[] | Error = []) {
  const batches: EnqueueRequest[][] = [];
  const lists: ListRequest[] = [];
  const queue = {
    settings: () => ({ messageType: { type: "object" }, maxMessageBytes: 64 }),
    async enqueue(items: EnqueueRequest[]) {
      batches.push(items);
      if (answers instanceof Error) throw answers;
      return items.map((item, index) => answers[index] ?? { status: "stored" });
    },
    claim: async () => ({ messages: [] }),
    renew: async () => ({ status: "held" }),
    complete: async () => ({ status: "settled" }),
    release: async () => ({ status: "settled" }),
    kill: async () => ({ status: "settled" }),
    stats: async () => ({}),
    get: async () => ({ status: "absent" }),
    async list(request: ListRequest) {
      lists.push(request);
      return { status: "page", messages: [], next: "tail-1" };
    },
    cancel: async () => ({ status: "absent" }),
    requeue: async () => ({ status: "absent" }),
  };
  return { queue, batches, lists };
}

const resource = (queue: unknown) => ({ metadata: { name: "op" }, queue });

describe("the message body", () => {
  it("is one text for one message whatever its key order, and reads back exactly", () => {
    const at = celTimestampFromMillis(Date.UTC(2026, 0, 2, 3, 4, 5));
    const wide = 9007199254740993n;
    const body = encodeMessageBody({ b: wide, a: { y: 1, x: at } });
    expect(body).toBe('{"a":{"x":"2026-01-02T03:04:05Z","y":1},"b":9007199254740993}');
    expect(encodeMessageBody({ a: { x: at, y: 1 }, b: wide })).toBe(body);
    expect(parseMessageBody(body)).toEqual({ a: { x: "2026-01-02T03:04:05Z", y: 1 }, b: wide });
  });
});

describe("Queue.Enqueue", () => {
  it("stores the canonical body under a minted id with the caller's trace", async () => {
    const { queue, batches } = store();
    const carrier = { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" };
    const op = await Enqueue.create(resource(queue), context(carrier));
    const out = await op.invoke({ message: { orderId: "o-1" } }, invocation);
    expect(out.enqueued).toBe(true);
    expect(out.id).toMatch(/^msg_[0-9A-Za-z]{22}$/);
    expect(batches).toEqual([
      [
        {
          id: out.id,
          body: '{"orderId":"o-1"}',
          digest: bodyDigest('{"orderId":"o-1"}'),
          generation: 1,
          traceparent: carrier.traceparent,
        },
      ],
    ]);
  });

  it("answers enqueued: false for a duplicate and refuses a conflict with its id", async () => {
    const duplicate = await Enqueue.create(resource(store([{ status: "duplicate" }]).queue), context());
    expect(await duplicate.invoke({ id: "evt-1", message: {} }, invocation)).toEqual({
      id: "evt-1",
      enqueued: false,
    });
    const conflict = await Enqueue.create(resource(store([{ status: "conflict" }]).queue), context());
    await expect(conflict.invoke({ id: "evt-1", message: {} }, invocation)).rejects.toMatchObject({
      code: "ERR_QUEUE_ID_CONFLICT",
      data: { id: "evt-1" },
    });
  });

  it("refuses a body over the bound before the store is called", async () => {
    const { queue, batches } = store();
    const op = await Enqueue.create(resource(queue), context());
    await expect(op.invoke({ message: { text: "x".repeat(80) } }, invocation)).rejects.toMatchObject({
      code: "ERR_QUEUE_MESSAGE_TOO_LARGE",
      data: { bytes: 91, maxBytes: 64 },
    });
    expect(batches).toEqual([]);
  });

  it("raises a storage failure as ERR_QUEUE_UNAVAILABLE, keeping it as the cause", async () => {
    const failure = new Error("connection reset");
    const op = await Enqueue.create(resource(store(failure).queue), context());
    const refusal = await op.invoke({ message: {} }, invocation).catch((err) => err);
    expect(refusal).toMatchObject({ code: "ERR_QUEUE_UNAVAILABLE" });
    expect(refusal.cause).toBe(failure);
  });
});

describe("terminal store answers", () => {
  it("raises an answer that is no outcome as ERR_QUEUE_STORE_INCONSISTENT", async () => {
    const op = await Enqueue.create(
      resource(store([{ status: "lost" } as unknown as EnqueueOutcome]).queue),
      context(),
    );
    await expect(op.invoke({ message: {} }, invocation)).rejects.toMatchObject({
      code: "ERR_QUEUE_STORE_INCONSISTENT",
    });
  });

  it("passes a store's group refusal through, naming the item only in a batch", async () => {
    const refusal = new InvokeError("ERR_QUEUE_GROUP_INVALID", "no customerId", { index: 1 });
    const many = await EnqueueMany.create(resource(store(refusal).queue), context());
    await expect(
      many.invoke({ messages: [{ message: {} }, { message: {} }] }, invocation),
    ).rejects.toMatchObject({ code: "ERR_QUEUE_GROUP_INVALID", data: { index: 1 } });
    const single = await Enqueue.create(
      resource(store(new InvokeError("ERR_QUEUE_GROUP_INVALID", "no customerId", { index: 0 })).queue),
      context(),
    );
    const error = await single.invoke({ message: {} }, invocation).catch((err) => err);
    expect(error).toMatchObject({ code: "ERR_QUEUE_GROUP_INVALID", data: {} });
  });
});

describe("Queue.EnqueueMany", () => {
  it("sends one batch and names the item a conflict is about", async () => {
    const { queue, batches } = store([{ status: "stored" }, { status: "conflict" }]);
    const op = await EnqueueMany.create(resource(queue), context());
    await expect(
      op.invoke({ messages: [{ message: {} }, { id: "dup", message: {} }] }, invocation),
    ).rejects.toMatchObject({ code: "ERR_QUEUE_ID_CONFLICT", data: { index: 1, id: "dup" } });
    expect(batches).toHaveLength(1);
  });

  it("stores nothing of a batch holding a body over the bound", async () => {
    const { queue, batches } = store();
    const op = await EnqueueMany.create(resource(queue), context());
    await expect(
      op.invoke({ messages: [{ message: {} }, { message: { text: "x".repeat(80) } }] }, invocation),
    ).rejects.toMatchObject({ code: "ERR_QUEUE_MESSAGE_TOO_LARGE", data: { index: 1 } });
    expect(batches).toEqual([]);
  });
});

describe("Queue.List", () => {
  it("hands the store back its own tail, and refuses a cursor from another state", async () => {
    const { queue, lists } = store();
    const op = await List.create(resource(queue), context());
    const first = await op.invoke({ state: "dead" }, invocation);
    await op.invoke({ state: "dead", cursor: first.next }, invocation);
    expect(lists[1]).toEqual({ state: "dead", limit: 100, after: "tail-1" });
    await expect(op.invoke({ state: "pending", cursor: first.next }, invocation)).rejects.toMatchObject({
      code: "ERR_QUEUE_CURSOR_INVALID",
    });
  });
});

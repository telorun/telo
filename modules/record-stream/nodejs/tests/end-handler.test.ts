import type { InvokeContext, ResourceContext } from "@telorun/sdk";
import { ERR_DURABLE_SUSPENDED, InvokeError, createCancellationSource } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create } from "../src/end-handler-controller.js";

interface HandlerCall {
  inputs: { records: unknown[]; context: unknown; outcome: unknown };
  ctx: InvokeContext | undefined;
}

/** The kernel's evaluation of the `inputs:` map, reduced to what these tests
 *  write: a map naming each binding it passes, or a function standing in for an
 *  expression that throws. */
function expandValue(value: unknown, bindings: Record<string, unknown>): unknown {
  if (typeof value === "function") return (value as () => unknown)();
  return Object.fromEntries(
    Object.entries(value as Record<string, string>).map(([key, binding]) => [key, bindings[binding]]),
  );
}

const ALL_BINDINGS = { records: "records", context: "context", outcome: "outcome" };

/** An EndHandler over a handler that records each call, and optionally fails. */
async function endHandler(handlerError?: Error, inputs: unknown = ALL_BINDINGS) {
  const calls: HandlerCall[] = [];
  const handler = {
    async invoke(inputs: HandlerCall["inputs"], ctx?: InvokeContext) {
      calls.push({ inputs, ctx });
      if (handlerError) throw handlerError;
      return {};
    },
  };
  const warnings: unknown[] = [];
  const ctx = {
    moduleContext: {},
    log: { warn: (...args: unknown[]) => warnings.push(args) },
    expandValue,
  } as unknown as ResourceContext;
  const instance = await create(
    { metadata: { name: "ending" }, handler, inputs: inputs as Record<string, unknown> },
    ctx,
  );
  return { instance, calls };
}

async function* items(values: unknown[], error?: unknown): AsyncGenerator<unknown> {
  for (const value of values) yield value;
  if (error !== undefined) throw error;
}

describe("RecordStream.EndHandler", () => {
  it("reports a failed input with its code, message and data, then raises it", async () => {
    const { instance, calls } = await endHandler();
    const boom = new InvokeError("ERR_TEST_BOOM", "the producer failed", { reason: "planned" });
    const { output } = await instance.invoke({ input: items([1, 2], boom), context: { tag: "t" } });

    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const item of output) seen.push(item);
      })(),
    ).rejects.toBe(boom);

    expect(seen).toEqual([1, 2]);
    expect(calls.map((call) => call.inputs)).toEqual([
      {
        records: [1, 2],
        context: { tag: "t" },
        outcome: {
          state: "failed",
          error: { code: "ERR_TEST_BOOM", message: "the producer failed", data: { reason: "planned" } },
        },
      },
    ]);
  });

  it("reports a consumer that stopped reading as cancelled with no error", async () => {
    const { instance, calls } = await endHandler();
    const { output } = await instance.invoke({ input: items([1, 2, 3]) });

    for await (const item of output) {
      if (item === 2) break;
    }

    expect(calls.map((call) => call.inputs)).toEqual([
      { records: [1, 2], context: undefined, outcome: { state: "cancelled", error: null } },
    ]);
  });

  it("ends a pending pull on its invocation's cancellation, and hands the handler an uncancelled context", async () => {
    const { instance, calls } = await endHandler();
    const source = createCancellationSource();
    // An input that yields once, then never again.
    const input = (async function* () {
      yield "first";
      await new Promise(() => undefined);
    })();
    const { output } = await instance.invoke({ input }, source.context);
    const iterator = output[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "first", done: false });
    const pending = iterator.next();
    source.cancel("deadline-exceeded");

    await expect(pending).rejects.toMatchObject({ code: "ERR_INVOKE_CANCELLED" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.inputs).toMatchObject({
      records: ["first"],
      outcome: { state: "cancelled", error: { code: "ERR_INVOKE_CANCELLED" } },
    });
    expect(calls[0]!.ctx?.cancellation.isCancelled).toBe(false);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(calls).toHaveLength(1);
  });

  it("ends the stream with the handler's failure, the original ending as its cause", async () => {
    const handlerError = new InvokeError("ERR_TEST_HANDLER", "the handler failed");
    const { instance } = await endHandler(handlerError);
    const boom = new Error("the producer failed");
    const { output } = await instance.invoke({ input: items([1], boom) });

    const raised = await (async () => {
      try {
        for await (const item of output) void item;
      } catch (err) {
        return err;
      }
    })();

    expect(raised).toBe(handlerError);
    expect((raised as { cause?: unknown }).cause).toBe(boom);
  });

  it("ends the stream with a failure to evaluate the handler's inputs, the original ending as its cause", async () => {
    const mapError = new InvokeError("ERR_TEST_MAP", "the inputs map failed to evaluate");
    const { instance, calls } = await endHandler(undefined, () => {
      throw mapError;
    });
    const boom = new Error("the producer failed");
    const { output } = await instance.invoke({ input: items([1], boom) });

    const raised = await (async () => {
      try {
        for await (const item of output) void item;
      } catch (err) {
        return err;
      }
    })();

    expect(raised).toBe(mapError);
    expect((raised as { cause?: unknown }).cause).toBe(boom);
    expect(calls).toHaveLength(0);
  });

  it("passes a durable suspension through without calling the handler", async () => {
    const { instance, calls } = await endHandler();
    const suspension = Object.assign(new Error("parked"), { code: ERR_DURABLE_SUSPENDED });
    const { output } = await instance.invoke({ input: items([1], suspension) });

    await expect(
      (async () => {
        for await (const item of output) void item;
      })(),
    ).rejects.toBe(suspension);
    expect(calls).toHaveLength(0);
  });
});

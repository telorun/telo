import type { InvokeContext, ResourceContext } from "@telorun/sdk";
import { ERR_INVOKE_CANCELLED, InvokeError, createCancellationSource } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create } from "../src/concat-controller.js";

/** A source's stream: an iterator that logs every pull it answers and whether
 *  it was stopped. `hang` makes the pull after the values never settle. */
function recorded(name: string, values: unknown[], log: string[], options: { error?: unknown; hang?: boolean } = {}) {
  let position = 0;
  const iterator: AsyncIterableIterator<unknown> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (position < values.length) return { value: values[position++], done: false };
      if (options.hang) return new Promise<IteratorResult<unknown>>(() => undefined);
      if (options.error !== undefined) throw options.error;
      log.push(`${name}:end`);
      return { value: undefined, done: true };
    },
    async return() {
      log.push(`${name}:stopped`);
      return { value: undefined, done: true };
    },
  };
  return iterator;
}

interface SourceCall {
  inputs: Record<string, unknown>;
  ctx: InvokeContext | undefined;
}

/** A Concat over sources that log their invocation, record what they were
 *  called with, and return the stream `streams[i]` builds. */
async function concat(streams: Array<(log: string[]) => AsyncIterable<unknown>>) {
  const log: string[] = [];
  const calls: SourceCall[] = [];
  const sources = streams.map((build, index) => ({
    invoke: {
      async invoke(inputs: Record<string, unknown>, ctx?: InvokeContext) {
        log.push(`${index}:invoked`);
        calls.push({ inputs, ctx });
        return { output: build(log) };
      },
    },
    inputs: { source: index },
  }));
  const ctx = {
    moduleContext: {},
    log: { warn: () => undefined },
    // The kernel's evaluation of a source's `inputs:` map, reduced to binding the
    // `context` the map reads beside its literal keys.
    expandValue: (value: Record<string, unknown>, bindings: Record<string, unknown>) => ({
      ...value,
      context: bindings.context,
    }),
  } as unknown as ResourceContext;
  const instance = await create({ metadata: { name: "joined" }, sources }, ctx);
  return { instance, log, calls };
}

describe("Stream.Concat", () => {
  it("invokes each source only once the previous stream has ended, under its own invocation context", async () => {
    const { instance, log, calls } = await concat([
      (log) => recorded("0", ["a", "b"], log),
      (log) => recorded("1", ["c"], log),
    ]);
    const invokeCtx = { cancellation: createCancellationSource().token };
    const { output } = await instance.invoke({ context: { tag: "t" } }, invokeCtx);
    expect(log).toEqual([]);

    for await (const item of output) log.push(`got:${String(item)}`);

    expect(log).toEqual(["0:invoked", "got:a", "got:b", "0:end", "1:invoked", "got:c", "1:end"]);
    expect(calls).toEqual([
      { inputs: { source: 0, context: { tag: "t" } }, ctx: invokeCtx },
      { inputs: { source: 1, context: { tag: "t" } }, ctx: invokeCtx },
    ]);
  });

  it("ends with a source's failure and invokes no later source", async () => {
    const boom = new InvokeError("ERR_TEST_BOOM", "the source failed");
    const { instance, log } = await concat([
      (log) => recorded("0", ["a"], log, { error: boom }),
      (log) => recorded("1", ["b"], log),
    ]);
    const { output } = await instance.invoke({});

    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const item of output) seen.push(item);
      })(),
    ).rejects.toBe(boom);

    expect(seen).toEqual(["a"]);
    expect(log).not.toContain("1:invoked");
  });

  it("stops the current source when the consumer stops, and invokes no later source", async () => {
    const { instance, log } = await concat([
      (log) => recorded("0", ["a", "b"], log),
      (log) => recorded("1", ["c"], log),
    ]);
    const { output } = await instance.invoke({});

    for await (const item of output) {
      log.push(`got:${String(item)}`);
      break;
    }

    expect(log).toEqual(["0:invoked", "got:a", "0:stopped"]);
  });

  it("raises ERR_INVOKE_CANCELLED on cancellation, stopping the current source mid-pull, and invokes no later source", async () => {
    const { instance, log } = await concat([
      (log) => recorded("0", ["a"], log, { hang: true }),
      (log) => recorded("1", ["b"], log),
    ]);
    const cancellation = createCancellationSource();
    const { output } = await instance.invoke({}, { cancellation: cancellation.token });
    const iterator = output[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "a", done: false });
    const waiting = iterator.next();
    cancellation.cancel("test over");

    await expect(waiting).rejects.toMatchObject({ code: ERR_INVOKE_CANCELLED });
    expect(log).toEqual(["0:invoked", "0:stopped"]);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });
});

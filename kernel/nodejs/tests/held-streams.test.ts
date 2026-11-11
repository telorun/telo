import { describe, expect, it } from "vitest";
import { Stream } from "@telorun/sdk";
import {
  DISPATCH_ENDED,
  heldStreamOf,
  HeldStream,
  holdLeavingRun,
  holdReturned,
  replaceStreams,
  rootOwner,
  StreamOwner,
} from "../src/held-streams.js";

/** A source counting how far it has been pulled. */
function counted<T>(items: T[]): { stream: Stream<T>; pulled: () => number } {
  let pulled = 0;
  async function* generate() {
    for (const item of items) {
      pulled++;
      yield item;
    }
  }
  return { stream: new Stream(generate()), pulled: () => pulled };
}

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

describe("a held stream", () => {
  it("keeps the run it leaves open until it is read to its end", async () => {
    const run = new StreamOwner(undefined, DISPATCH_ENDED);
    const caller = new StreamOwner(undefined, DISPATCH_ENDED);
    const { stream } = counted(["a", "b"]);
    const value = holdLeavingRun({ output: stream }, run, caller) as { output: Stream<string> };
    run.produce();
    expect(run.closed).toBe(false);
    expect(await drain(value.output)).toEqual(["a", "b"]);
    expect(run.closed).toBe(true);
  });

  it("forwards each item as the consumer pulls it, never ahead, and a bytes chunk unchanged", async () => {
    const chunks = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    const { stream, pulled } = counted(chunks);
    const held = new HeldStream(stream, "Telo.Sequence 'reply'", [], undefined);
    held.registerWith(rootOwner());
    const iterator = held.stream[Symbol.asyncIterator]();
    expect(pulled()).toBe(0);
    const first = await iterator.next();
    expect(pulled()).toBe(1);
    expect(first.value).toBe(chunks[0]);
    expect((await iterator.next()).value).toBe(chunks[1]);
    expect(pulled()).toBe(2);
  });

  it("is cancelled when the dispatch owning it ends without reading it, settling what it held open", async () => {
    const run = new StreamOwner(undefined, DISPATCH_ENDED);
    const dispatch = new StreamOwner(undefined, DISPATCH_ENDED);
    const value = holdLeavingRun({ output: counted(["a"]).stream }, run, dispatch) as { output: Stream<string> };
    run.produce();
    dispatch.produce();
    expect(run.closed).toBe(true);
    await expect(drain(value.output)).rejects.toMatchObject({
      code: "ERR_INVOKE_CANCELLED",
      message: expect.stringContaining("the dispatch that received it ended"),
    });
  });

  it("reaching a caller that opened no context is cancelled at once, naming the fix", async () => {
    const run = new StreamOwner(undefined, DISPATCH_ENDED);
    const value = holdLeavingRun({ output: counted(["a"]).stream }, run, undefined) as { output: Stream<string> };
    run.produce();
    expect(run.closed).toBe(true);
    await expect(drain(value.output)).rejects.toMatchObject({
      code: "ERR_INVOKE_CANCELLED",
      message: expect.stringContaining("ctx.createCancellationSource()"),
    });
  });

  it("refuses a second read once consumed, saying its scope has ended", async () => {
    const run = new StreamOwner(undefined, DISPATCH_ENDED, undefined, "Telo.Sequence 'reply'");
    const value = holdLeavingRun({ output: counted(["a"]).stream }, run, rootOwner()) as { output: Stream<string> };
    run.produce();
    await drain(value.output);
    await expect(drain(value.output)).rejects.toMatchObject({
      code: "ERR_INVOKE_CANCELLED",
      message: expect.stringMatching(/Telo\.Sequence 'reply' was already consumed and its scope has ended/),
    });
  });

  it("derived from one a dispatch owns keeps it alive until the derived stream settles, and cancels it then", async () => {
    const run = new StreamOwner(undefined, DISPATCH_ENDED);
    const dispatch = new StreamOwner(undefined, DISPATCH_ENDED);
    const caller = rootOwner();
    const source = (holdLeavingRun({ output: counted(["a", "b", "c"]).stream }, run, dispatch) as { output: Stream<string> })
      .output;
    run.produce();
    // The dispatch maps the held stream and returns only the first item of it.
    async function* firstOnly() {
      for await (const item of source) {
        yield String(item).toUpperCase();
        return;
      }
    }
    const derived = (holdReturned({ output: new Stream(firstOnly()) }, dispatch, caller, "Telo.Sequence 'decoded'", undefined) as {
      output: Stream<string>;
    }).output;
    dispatch.produce();
    expect(heldStreamOf(source)!.isSettled).toBe(false);
    expect(run.closed).toBe(false);
    expect(await drain(derived)).toEqual(["A"]);
    expect(dispatch.closed).toBe(true);
    expect(heldStreamOf(source)!.isSettled).toBe(true);
    expect(run.closed).toBe(true);
  });

  it("holds a stream inside each item as the item is pulled, keeping the run open until it settles", async () => {
    const run = new StreamOwner(undefined, DISPATCH_ENDED);
    const parts = counted([{ name: "p0", content: counted(["x"]).stream }]).stream;
    const value = holdLeavingRun({ parts }, run, rootOwner()) as { parts: Stream<{ content: Stream<string> }> };
    run.produce();
    const [part] = (await drain(value.parts)) as Array<{ content: Stream<string> }>;
    expect(heldStreamOf(part!.content)).toBeDefined();
    expect(run.closed).toBe(false);
    expect(await drain(part!.content)).toEqual(["x"]);
    expect(run.closed).toBe(true);
  });
});

describe("a walk for held streams", () => {
  it("hands back the identical value, an unscoped stream included, when nothing is held", () => {
    const stream = counted([1]).stream;
    const value = { body: { rows: [{ n: 1 }] }, output: stream };
    const walked = replaceStreams(value, undefined, (found, held) => (held ? found : found));
    expect(walked).toBe(value);
    expect((walked as typeof value).output).toBe(stream);
  });

  it("skips a subtree whose contract is closed and holds no stream type", () => {
    const touched: string[] = [];
    const body = new Proxy({ a: 1 }, {
      ownKeys(target) {
        touched.push("body");
        return Reflect.ownKeys(target);
      },
    });
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        body: { type: "object", additionalProperties: false, properties: { a: { type: "integer" } } },
        output: { "x-telo-type": "Telo.Stream" },
      },
    };
    const visited: unknown[] = [];
    replaceStreams({ body, output: counted([1]).stream }, { schema, resolveRef: () => undefined }, (stream) => {
      visited.push(stream);
      return stream;
    });
    expect(touched).toEqual([]);
    expect(visited).toHaveLength(1);
  });

  it("enters an open contract and finds a stream at an undeclared path", () => {
    const schema = { type: "object", additionalProperties: true };
    const visited: unknown[] = [];
    replaceStreams({ nested: { output: counted([1]).stream } }, { schema, resolveRef: () => undefined }, (stream) => {
      visited.push(stream);
      return stream;
    });
    expect(visited).toHaveLength(1);
  });
});

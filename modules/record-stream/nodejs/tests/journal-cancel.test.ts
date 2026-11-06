import { NEVER_CANCELLED, type ResourceContext } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { ERR_JOURNAL_CANCELLED, Journal } from "../src/journal.js";
import type { JournalStore } from "../src/journal-store-contract.js";
import { create as createSink } from "../src/journal-sink-controller.js";
import { create as createStore } from "../src/memory-journal-store.js";

class TestJournal extends Journal {
  constructor(private readonly backing: JournalStore) {
    super({ markerRetentionMs: 60_000, writerTimeoutMs: 3_000 });
  }

  protected get store(): JournalStore {
    return this.backing;
  }
}

const ctx = {
  resolveRef: (value: unknown) => value,
  log: { warn: () => undefined, error: () => undefined },
} as unknown as ResourceContext;

/** An input that yields what it is given, one value per `push`, and ends on `end`. */
function controlledInput() {
  const queue: Array<(r: IteratorResult<unknown>) => void> = [];
  const buffered: Array<IteratorResult<unknown>> = [];
  let returned = false;
  const deliver = (result: IteratorResult<unknown>) => {
    const waiting = queue.shift();
    if (waiting) waiting(result);
    else buffered.push(result);
  };
  const iterable: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        buffered.length > 0
          ? Promise.resolve(buffered.shift()!)
          : new Promise<IteratorResult<unknown>>((resolve) => queue.push(resolve)),
      return: async () => {
        returned = true;
        return { value: undefined, done: true };
      },
    }),
  };
  return {
    iterable,
    push: (value: unknown) => deliver({ value, done: false }),
    wasReturned: () => returned,
  };
}

async function setup() {
  const journal = new TestJournal(await createStore());
  const sink = await createSink({ metadata: { name: "sink" }, journal }, ctx);
  return { journal, sink };
}

describe("RecordStream.JournalCancel", () => {
  it("stops a sink that is idle waiting for input: the key fails as cancelled, the input is returned, the code is raised", async () => {
    const { journal, sink } = await setup();
    const input = controlledInput();
    const drained = sink.invoke({ key: "idle", input: input.iterable });
    drained.catch(() => undefined);
    await expect.poll(async () => (await journal.read("idle", 0, 0)).state).toBe("open");

    await expect(journal.cancel("idle")).resolves.toBe("requested");

    await expect(drained).rejects.toMatchObject({ code: ERR_JOURNAL_CANCELLED });
    expect(input.wasReturned()).toBe(true);
    expect(await journal.read("idle", 0)).toMatchObject({
      state: "failed",
      error: { code: ERR_JOURNAL_CANCELLED, data: { key: "idle" } },
    });
  });

  it("stops a sink whose next append is refused by the request", async () => {
    const { journal, sink } = await setup();
    const input = controlledInput();
    const drained = sink.invoke({ key: "writing", input: input.iterable });
    drained.catch(() => undefined);
    input.push("a");
    await expect.poll(async () => (await journal.read("writing", 0, 0)).lastId).toBe(1);

    await journal.cancel("writing");
    input.push("b");

    await expect(drained).rejects.toMatchObject({ code: ERR_JOURNAL_CANCELLED });
    expect(await journal.read("writing", 0)).toMatchObject({
      state: "failed",
      error: { code: ERR_JOURNAL_CANCELLED },
      entries: [{ id: 1, data: "a" }],
    });
  });

  it("keeps a request made on a claimed key through its adoption", async () => {
    const { journal, sink } = await setup();
    await journal.reserve("claimed", { writer: "w" });
    await expect(journal.cancel("claimed")).resolves.toBe("requested");

    const input = controlledInput();
    await expect(sink.invoke({ key: "claimed", input: input.iterable, writer: "w" })).rejects.toMatchObject({
      code: ERR_JOURNAL_CANCELLED,
    });
    expect((await journal.read("claimed", 0, 0)).state).toBe("failed");
  });

  it("answers requested again while the request is pending, and ended once the key ended", async () => {
    const { journal } = await setup();
    await journal.reserve("pending", { writer: "w" });
    await expect(journal.cancel("pending")).resolves.toBe("requested");
    await expect(journal.cancel("pending")).resolves.toBe("requested");
    const writer = await journal.claim("pending", { writer: "w" });
    await expect(writer.failCancelled()).resolves.toBeUndefined();
    await expect(journal.cancel("pending")).resolves.toBe("ended");
    expect(await journal.read("pending", 0, 0)).toMatchObject({ state: "failed", error: { code: ERR_JOURNAL_CANCELLED } });
  });

  it("lets a reader tailing the key see it raise the code", async () => {
    const { journal, sink } = await setup();
    const input = controlledInput();
    const drained = sink.invoke({ key: "tailed", input: input.iterable });
    drained.catch(() => undefined);
    await expect.poll(async () => (await journal.read("tailed", 0, 0)).state).toBe("open");
    const reader = await journal.open("tailed", 0, NEVER_CANCELLED);
    const reading = reader.next();
    await journal.cancel("tailed");
    await expect(reading).rejects.toMatchObject({ code: ERR_JOURNAL_CANCELLED });
  });
});

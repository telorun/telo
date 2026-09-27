import { NEVER_CANCELLED, type ResourceContext } from "@telorun/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Journal, type JournalEntry } from "../src/journal.js";
import type { JournalStore } from "../src/journal-store-contract.js";
import { create as createSink } from "../src/journal-sink-controller.js";
import { create as createStore } from "../src/memory-journal-store.js";

const WRITER_TIMEOUT_MS = 3_000;

class TestJournal extends Journal {
  constructor(private readonly backing: JournalStore) {
    super({ markerRetentionMs: 60_000, writerTimeoutMs: WRITER_TIMEOUT_MS });
  }

  protected get store(): JournalStore {
    return this.backing;
  }
}

/** Counts the header rewrites a writer makes — its heartbeats, once it has claimed. */
function countingHeaderWrites(store: JournalStore): { store: JournalStore; writes: () => number } {
  let writes = 0;
  const counted = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "compareAndSet" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        writes++;
        return value.apply(target, args);
      };
    },
  });
  return { store: counted, writes: () => writes };
}

describe("RecordStream.JournalSink heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("touches the key every third of the writer timeout while its input is paused, so a reader never fails it", async () => {
    const { store, writes } = countingHeaderWrites(await createStore());
    const journal = new TestJournal(store);
    const ctx = { resolveRef: (value: unknown) => value, log: {} } as unknown as ResourceContext;
    const sink = await createSink({ metadata: { name: "sink" }, journal }, ctx);

    let resume: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const input = (async function* () {
      yield 1;
      await paused;
      yield 2;
    })();

    const drained = sink.invoke({ key: "paused", input });
    await vi.advanceTimersByTimeAsync(0);
    const reader = await journal.open("paused", 0, NEVER_CANCELLED);
    const received: JournalEntry[] = [];
    const reading = (async () => {
      for await (const entry of reader) received.push(entry);
    })();

    const before = writes();
    // Ten writer timeouts of silence from the input.
    for (let tick = 1; tick <= 30; tick++) {
      await vi.advanceTimersByTimeAsync(WRITER_TIMEOUT_MS / 3);
      expect(writes() - before).toBe(tick);
    }
    expect((await journal.read("paused", 0, 0)).state).toBe("open");

    resume();
    await vi.advanceTimersByTimeAsync(0);
    await expect(drained).resolves.toEqual({ key: "paused", count: 2 });
    await reading;
    expect(received).toEqual([
      { id: 1, data: 1 },
      { id: 2, data: 2 },
    ]);
  });
});

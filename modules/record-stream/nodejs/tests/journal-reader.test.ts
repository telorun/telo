import { NEVER_CANCELLED } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { Journal } from "../src/journal.js";
import type { JournalStore } from "../src/journal-store-contract.js";
import { create } from "../src/memory-journal-store.js";

/** Counts every call a journal makes to its store. */
function counting(store: JournalStore): { store: JournalStore; calls: () => number } {
  let calls = 0;
  const counted = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls++;
        return value.apply(target, args);
      };
    },
  });
  return { store: counted, calls: () => calls };
}

class TestJournal extends Journal {
  constructor(private readonly backing: JournalStore) {
    super({ retentionMs: 60_000, writerTimeoutMs: 60_000 });
  }

  protected get store(): JournalStore {
    return this.backing;
  }
}

describe("JournalReader", () => {
  it("makes no further store call once its consumer stops, even while waiting", async () => {
    const { store, calls } = counting(await create());
    const journal = new TestJournal(store);
    const writer = await journal.claim("live");
    await writer.append({ n: 1 });

    const reader = await journal.open("live", 0, NEVER_CANCELLED);
    expect(await reader.next()).toEqual({ value: { id: 1, data: { n: 1 } }, done: false });
    // Caught up on a live key: this next() is waiting on the store.
    const pending = reader.next();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const before = calls();
    expect(await reader.return()).toEqual({ value: undefined, done: true });
    expect(await pending).toEqual({ value: undefined, done: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls()).toBe(before);
  });
});

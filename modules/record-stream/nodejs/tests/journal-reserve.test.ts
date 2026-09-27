import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../src/journal.js";
import type { JournalStore } from "../src/journal-store-contract.js";
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

/** The store under a hook that runs once, before the next header write. */
function beforeNextHeaderWrite(store: JournalStore): { store: JournalStore; arm: (hook: () => Promise<void>) => void } {
  let armed: (() => Promise<void>) | undefined;
  const hooked = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "compareAndSet" || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const hook = armed;
        armed = undefined;
        if (hook) await hook();
        return value.apply(target, args);
      };
    },
  });
  return { store: hooked, arm: (hook) => (armed = hook) };
}

describe("Journal.reserve under a writer whose drain stopped heartbeating", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails the key as lost and returns it unchanged, never taking it over", async () => {
    const store = await createStore();
    const journal = new TestJournal(store);
    await journal.reserve("k", { writer: "w" });
    const drain = await journal.claim("k", { writer: "w" });
    await drain.append({ n: 1 });

    // The drain dies: nothing touches the key past its timeout.
    await vi.advanceTimersByTimeAsync(WRITER_TIMEOUT_MS + 1_000);

    const claimed = await journal.reserve("k", { writer: "w", resume: true });
    const header = (await store.read("k", 0, 0)).header!;
    expect(claimed).toEqual({ version: header.version, lastId: 1 });
    const failed = {
      state: "failed",
      error: {
        code: "ERR_JOURNAL_WRITER_LOST",
        message:
          "RecordStream.Journal: the writer of key 'k' stopped sending heartbeats within its timeout, so the key was failed.",
        data: { key: "k" },
      },
      lastId: 1,
      entries: [{ id: 1, data: { n: 1 } }],
    };
    expect(await journal.read("k", 0)).toEqual(failed);

    // Asked again, the failed key is returned as it is.
    expect(await journal.reserve("k", { writer: "w", resume: true })).toEqual(claimed);
    expect(await journal.read("k", 0)).toEqual(failed);
  });

  it("judges the key again when the drain heartbeats between the read and the failure", async () => {
    const { store, arm } = beforeNextHeaderWrite(await createStore());
    const journal = new TestJournal(store);
    await journal.reserve("k", { writer: "w" });
    const drain = await journal.claim("k", { writer: "w" });
    await vi.advanceTimersByTimeAsync(WRITER_TIMEOUT_MS + 1_000);

    // The drain was only late: its heartbeat lands before the failure is written.
    arm(() => drain.touch());
    const claimed = await journal.reserve("k", { writer: "w", resume: true });

    const header = (await store.read("k", 0, 0)).header!;
    expect(claimed).toEqual({ version: header.version, lastId: 0 });
    expect((await journal.read("k", 0, 0)).state).toBe("open");
    await drain.append({ n: 1 });
    await drain.finish();
    expect((await journal.read("k", 0)).state).toBe("finished");
  });
});

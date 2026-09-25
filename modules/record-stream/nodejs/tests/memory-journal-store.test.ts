import { createCancellationSource } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create } from "../src/memory-journal-store.js";

const waiters = (store: object) => (store as unknown as { waiters: Map<string, unknown> }).waiters;

describe("MemoryJournalStore.wait", () => {
  it("resolves at once when cancelled, and leaves no waiter entry behind", async () => {
    const store = await create();
    const source = createCancellationSource();
    const waiting = store.wait("absent", null, 60_000, source.token);
    expect(waiters(store).size).toBe(1);
    source.cancel("stop");
    await waiting;
    expect(waiters(store).size).toBe(0);
  });
});

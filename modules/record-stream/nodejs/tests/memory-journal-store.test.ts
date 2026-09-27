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

describe("MemoryJournalStore.lastId", () => {
  it("is reported the same by scan as by read for the same key", async () => {
    const store = await create();
    let version = (await store.putIfAbsent("k", "header"))!;
    for (const record of ["a", "b", "c"]) version = (await store.compareAndAppend("k", version, record))!.version;

    const read = (await store.read("k", 0, 0)).header!;
    const scanned = (await store.scan(0, null, 10)).headers.find((header) => header.key === "k")!;
    expect(read.lastId).toBe(3);
    expect(scanned.lastId).toBe(read.lastId);
  });
});

import { NEVER_CANCELLED, type Inverse, type ResourceContext } from "@telorun/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create as createStore } from "../src/memory-store-controller.js";

type Store = Awaited<ReturnType<typeof createStore>>;

/** Runs the store's `init()` chain and hands back the inverse it registered. */
async function initialize(store: Store): Promise<Inverse> {
  let body: (() => Promise<{ inverse?: Inverse }>) | undefined;
  const ctx = {
    effect: (reason: string, forward: () => Promise<{ inverse?: Inverse }>) => {
      body = forward;
      return {};
    },
  } as unknown as ResourceContext;
  store.init(ctx);
  const outcome = await body!();
  return outcome.inverse!;
}

/** What the store remembers for a topic, read without waiting. */
function known(store: Store, topic: string) {
  return store.wait(topic, -1n, 0, NEVER_CANCELLED);
}

describe("Watch.MemoryStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never forgets a waited topic past maxTopics, and forgets only topics nobody waits on", async () => {
    const store = await createStore({ metadata: { name: "store" }, maxTopics: 2 });
    await store.raise("a", 1n);
    await store.raise("b", 1n);
    const waitingA = store.wait("a", 1n, 30_000, NEVER_CANCELLED);
    const waitingB = store.wait("b", 1n, 30_000, NEVER_CANCELLED);

    // Three more topics: two fit beside the waited ones, the oldest idle one goes.
    await store.raise("c", 1n);
    await store.raise("d", 1n);
    await store.raise("e", 1n);
    expect(await known(store, "c")).toEqual({ changed: true, version: 0n });
    expect(await known(store, "d")).toEqual({ changed: true, version: 1n });
    expect(await known(store, "e")).toEqual({ changed: true, version: 1n });

    await store.raise("a", 2n);
    await store.raise("b", 2n);
    await expect(waitingA).resolves.toEqual({ changed: true, version: 2n });
    await expect(waitingB).resolves.toEqual({ changed: true, version: 2n });
    expect(vi.getTimerCount()).toBe(0);

    // Back in the eviction order at the most recent end: d and e went, a and b stay.
    expect(await known(store, "a")).toEqual({ changed: true, version: 2n });
    expect(await known(store, "b")).toEqual({ changed: true, version: 2n });
    expect(await known(store, "d")).toEqual({ changed: true, version: 0n });
    expect(await known(store, "e")).toEqual({ changed: true, version: 0n });
  });

  it("returns changed: false at its timeout when the topic was forgotten before the wait opened", async () => {
    const store = await createStore({ metadata: { name: "store" }, maxTopics: 1 });
    await store.raise("plan", 5n);
    await store.raise("other", 1n);

    let settled: unknown;
    void store.wait("plan", 4n, 50, NEVER_CANCELLED).then((signal) => {
      settled = signal;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ changed: false, version: 0n });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves a pending wait with changed: false at teardown and leaves no timer", async () => {
    const store = await createStore({ metadata: { name: "store" } });
    const inverse = await initialize(store);
    await store.raise("plan", 3n);
    const waiting = store.wait("plan", 3n, 30_000, NEVER_CANCELLED);
    expect(vi.getTimerCount()).toBe(1);

    await inverse();
    await expect(waiting).resolves.toEqual({ changed: false, version: 3n });
    expect(vi.getTimerCount()).toBe(0);
  });
});

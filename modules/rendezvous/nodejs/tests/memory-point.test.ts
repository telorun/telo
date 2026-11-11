import {
  celDurationFromNanos,
  createCancellationSource,
  type ResourceContext,
} from "@telorun/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "../src/memory-point-controller.js";
import { isRendezvousPoint } from "../src/rendezvous-point-contract.js";

const seconds = (n: number) => celDurationFromNanos(BigInt(n) * 1_000_000_000n);
const point = (hold?: unknown) => create({ metadata: { name: "decisions" }, hold });

describe("Rendezvous.MemoryPoint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is recognised by its methods", async () => {
    expect(isRendezvousPoint(await point())).toBe(true);
    expect(isRendezvousPoint({ take: () => {} })).toBe(false);
  });

  it("keeps a held value for 60s when no hold is configured", async () => {
    const p = await point();
    await p.offer("k", 1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(await p.take("k", 0)).toEqual({ outcome: "taken", payload: 1 });
    await p.offer("k", 2);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await p.take("k", 0)).toEqual({ outcome: "timedOut" });
  });

  it("restarts the window when a held value is replaced", async () => {
    const p = await point(seconds(10));
    await p.offer("k", 1);
    await vi.advanceTimersByTimeAsync(8_000);
    await p.offer("k", 2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await p.take("k", 0)).toEqual({ outcome: "taken", payload: 2 });
  });

  it("holds a value past the longest Node timer delay and expires it at its deadline", async () => {
    const day = 86_400;
    const p = await point(seconds(30 * day));
    await p.offer("k", 1);
    await vi.advanceTimersByTimeAsync(25 * day * 1000);
    expect(await p.take("k", 0)).toEqual({ outcome: "taken", payload: 1 });
    await p.offer("k", 2);
    await vi.advanceTimersByTimeAsync(29 * day * 1000);
    await p.offer("k", 3);
    await vi.advanceTimersByTimeAsync(29 * day * 1000);
    expect(await p.take("k", 0)).toEqual({ outcome: "taken", payload: 3 });
    await p.offer("k", 4);
    await vi.advanceTimersByTimeAsync(30 * day * 1000 + 1);
    expect(await p.take("k", 0)).toEqual({ outcome: "timedOut" });
  });

  it("expires a sub-millisecond hold at its deadline", async () => {
    const p = await point(celDurationFromNanos(500_000n));
    await p.offer("k", 1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p.take("k", 0)).toEqual({ outcome: "timedOut" });
  });

  it("gives a value to one take only, and a cancelled take consumes nothing", async () => {
    const p = await point();
    const source = createCancellationSource();
    const first = p.take("k", 5_000, source.context);
    expect(await p.take("k", 5_000)).toEqual({ outcome: "busy" });
    source.cancel("stop");
    expect(await first).toEqual({ outcome: "cancelled" });
    expect(await p.offer("k", 1)).toEqual({ outcome: "held" });
    expect(await p.take("k", 0)).toEqual({ outcome: "taken", payload: 1 });
  });

  it("resolves a waiting take as cancelled when its resource is torn down", async () => {
    const p = await point();
    let inverse: (() => void) | undefined;
    const ctx = {
      effect: async (reason: string, body: () => Promise<{ inverse: () => void }>) => {
        inverse = (await body()).inverse;
      },
    } as unknown as ResourceContext;
    await p.init(ctx);
    const waiting = p.take("k", 5_000);
    inverse?.();
    expect(await waiting).toEqual({ outcome: "cancelled" });
  });
});

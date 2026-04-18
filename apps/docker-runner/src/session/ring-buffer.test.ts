import { describe, expect, it } from "vitest";

import type { RunEvent } from "../types.js";
import { EventRingBuffer } from "./ring-buffer.js";

function stdout(chunk: string): RunEvent {
  return { type: "stdout", chunk };
}

describe("EventRingBuffer", () => {
  it("assigns monotonic ids starting at 1", () => {
    const buf = new EventRingBuffer(1_000_000);
    const a = buf.push(stdout("a"));
    const b = buf.push(stdout("b"));
    const c = buf.push(stdout("c"));
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(c.id).toBe(3);
  });

  it("replay(0) returns all entries, hasGap=false", () => {
    const buf = new EventRingBuffer(1_000_000);
    buf.push(stdout("a"));
    buf.push(stdout("b"));
    const { entries, hasGap } = buf.replay(0);
    expect(entries.map((e) => e.id)).toEqual([1, 2]);
    expect(hasGap).toBe(false);
  });

  it("replay(n) returns only entries with id > n", () => {
    const buf = new EventRingBuffer(1_000_000);
    buf.push(stdout("a"));
    buf.push(stdout("b"));
    buf.push(stdout("c"));
    const { entries } = buf.replay(1);
    expect(entries.map((e) => e.id)).toEqual([2, 3]);
  });

  it("evicts oldest entries FIFO when total bytes exceeds cap", () => {
    // Each stdout("x".repeat(100)) serializes to about 120 bytes in JSON.
    const buf = new EventRingBuffer(300);
    for (let i = 0; i < 20; i++) buf.push(stdout("x".repeat(100)));
    expect(buf.bytes).toBeLessThanOrEqual(300 + 200); // within one entry of cap
    expect(buf.size).toBeLessThan(20);
    // latestId still reflects total pushed, not the oldest still resident.
    expect(buf.latestId).toBe(20);
  });

  it("replay after eviction reports hasGap=true when requested id was evicted", () => {
    const buf = new EventRingBuffer(200);
    for (let i = 0; i < 10; i++) buf.push(stdout("x".repeat(100)));
    // oldest resident id is likely 9 or 10 given the cap.
    const oldest = buf.replay(0).entries[0]?.id ?? 0;
    expect(oldest).toBeGreaterThan(1);
    const { hasGap } = buf.replay(0);
    expect(hasGap).toBe(true);
  });

  it("replay on a fresh buffer returns empty with no gap", () => {
    const buf = new EventRingBuffer(1000);
    const { entries, hasGap } = buf.replay(0);
    expect(entries).toEqual([]);
    expect(hasGap).toBe(false);
  });

  it("rejects non-positive maxBytes", () => {
    expect(() => new EventRingBuffer(0)).toThrow();
    expect(() => new EventRingBuffer(-1)).toThrow();
  });
});

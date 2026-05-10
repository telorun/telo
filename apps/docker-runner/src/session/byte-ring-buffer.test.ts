import { describe, expect, it } from "vitest";

import { ByteRingBuffer } from "./byte-ring-buffer.js";

describe("ByteRingBuffer", () => {
  it("assigns monotonic seq starting at 1 and never reuses", () => {
    const buf = new ByteRingBuffer(1024);
    expect(buf.push(Buffer.from("a")).seq).toBe(1);
    expect(buf.push(Buffer.from("b")).seq).toBe(2);
    expect(buf.push(Buffer.from("c")).seq).toBe(3);
    expect(buf.latestSeq).toBe(3);
  });

  it("evicts oldest entries when over byte cap", () => {
    const buf = new ByteRingBuffer(10);
    buf.push(Buffer.from("aaaa")); // 4 bytes, total 4
    buf.push(Buffer.from("bbbb")); // 4 bytes, total 8
    buf.push(Buffer.from("cccc")); // 4 bytes, total 12 → evict "aaaa"
    expect(buf.size).toBe(2);
    expect(buf.bytes).toBe(8);
  });

  it("retains the most-recent entry even if it alone exceeds the cap", () => {
    const buf = new ByteRingBuffer(8);
    buf.push(Buffer.from("aaaa"));
    buf.push(Buffer.from("bbbb"));
    buf.push(Buffer.alloc(100, 0x63)); // 100 bytes — far over cap
    expect(buf.size).toBe(1);
    expect(buf.bytes).toBe(100);
  });

  it("replay(0) returns everything still resident, no gap", () => {
    const buf = new ByteRingBuffer(1024);
    buf.push(Buffer.from("a"));
    buf.push(Buffer.from("b"));
    const r = buf.replay(0);
    expect(r.entries.map((e) => e.bytes.toString())).toEqual(["a", "b"]);
    expect(r.hasGap).toBe(false);
  });

  it("replay(n) returns entries with seq > n", () => {
    const buf = new ByteRingBuffer(1024);
    buf.push(Buffer.from("a")); // seq 1
    buf.push(Buffer.from("b")); // seq 2
    buf.push(Buffer.from("c")); // seq 3
    const r = buf.replay(1);
    expect(r.entries.map((e) => e.seq)).toEqual([2, 3]);
    expect(r.hasGap).toBe(false);
  });

  it("flags hasGap when oldest seq is past the requested resume point", () => {
    const buf = new ByteRingBuffer(8);
    buf.push(Buffer.from("aaaa")); // seq 1
    buf.push(Buffer.from("bbbb")); // seq 2
    buf.push(Buffer.from("cccc")); // seq 3 — evicts seq 1; oldest now seq 2
    const r = buf.replay(0); // wants > 0; oldest is 2 → gap of seq 1
    expect(r.hasGap).toBe(true);
    expect(r.entries.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("rejects non-positive maxBytes", () => {
    expect(() => new ByteRingBuffer(0)).toThrow();
    expect(() => new ByteRingBuffer(-1)).toThrow();
    expect(() => new ByteRingBuffer(1.5)).toThrow();
  });
});

import { SessionRegistry } from "./registry.js";

describe("SessionRegistry.pushBytes (chunk splitting)", () => {
  it("splits oversized buffers into MAX_PUSH_CHUNK-sized entries", () => {
    const registry = new SessionRegistry({
      maxSessions: 4,
      exitTtlMs: 60_000,
      replayBufferBytes: 1_000_000,
    });
    const entry = registry.register({
      sessionId: "s1",
      containerName: "c1",
      bundleWorkdir: {} as unknown as import("./bundle-workdir.js").BundleWorkdir,
    });
    // 200 KB > MAX_PUSH_CHUNK (64 KB) — should produce 4 entries (64+64+64+8).
    const big = Buffer.alloc(200 * 1024, 0x61);
    registry.pushBytes("s1", big);
    expect(entry.byteBuffer.size).toBe(4);
    const replayed = entry.byteBuffer.replay(0).entries;
    expect(replayed.map((e) => e.bytes.byteLength)).toEqual([
      64 * 1024,
      64 * 1024,
      64 * 1024,
      8 * 1024,
    ]);
    // Concatenating all replayed entries reconstructs the original buffer.
    expect(Buffer.concat(replayed.map((e) => e.bytes)).equals(big)).toBe(true);
  });

  it("emits one byteEmitter event per split slice", () => {
    const registry = new SessionRegistry({
      maxSessions: 4,
      exitTtlMs: 60_000,
      replayBufferBytes: 1_000_000,
    });
    registry.register({
      sessionId: "s2",
      containerName: "c2",
      bundleWorkdir: {} as unknown as import("./bundle-workdir.js").BundleWorkdir,
    });
    const seqs: number[] = [];
    registry.subscribeBytes("s2", (b) => {
      seqs.push(b.seq);
    });
    registry.pushBytes("s2", Buffer.alloc(150 * 1024)); // expect 3 slices (64+64+22)
    expect(seqs).toEqual([1, 2, 3]);
  });
});

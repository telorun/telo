import { describe, expect, it } from "vitest";

import { ByteRingBuffer } from "./byte-ring-buffer.js";
import { EventRingBuffer } from "./ring-buffer.js";
import { normalizeBundlePath, validateSessionId, BundlePathError } from "./bundle-path.js";

describe("EventRingBuffer", () => {
  it("assigns monotonic ids starting at 1 and replays after an id", () => {
    const buf = new EventRingBuffer(1_000_000);
    buf.push({ type: "stdout", chunk: "a" });
    buf.push({ type: "stdout", chunk: "b" });
    const { entries, hasGap } = buf.replay(1);
    expect(entries.map((e) => e.id)).toEqual([2]);
    expect(hasGap).toBe(false);
  });

  it("evicts oldest entries past the byte cap but always retains the last", () => {
    const buf = new EventRingBuffer(50);
    for (let i = 0; i < 20; i++) buf.push({ type: "stdout", chunk: "x".repeat(20) });
    expect(buf.size).toBeGreaterThanOrEqual(1);
    expect(buf.bytes).toBeLessThanOrEqual(50 + 40);
    const { hasGap } = buf.replay(0);
    expect(hasGap).toBe(true);
  });
});

describe("ByteRingBuffer", () => {
  it("replays chunks after a seq and flags gaps when evicted", () => {
    const buf = new ByteRingBuffer(10);
    buf.push(Buffer.from("aaaaa"));
    buf.push(Buffer.from("bbbbb"));
    buf.push(Buffer.from("ccccc"));
    const { entries, hasGap } = buf.replay(0);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(hasGap).toBe(true);
  });
});

describe("normalizeBundlePath", () => {
  it("strips leading slashes and keeps nested paths", () => {
    expect(normalizeBundlePath("/a/b.yaml")).toBe("a/b.yaml");
    expect(normalizeBundlePath("a/b.yaml")).toBe("a/b.yaml");
  });

  it("rejects traversal", () => {
    expect(() => normalizeBundlePath("../x")).toThrow(BundlePathError);
    expect(() => normalizeBundlePath("a/../../x")).toThrow(BundlePathError);
  });

  it("validates sessionIds", () => {
    expect(() => validateSessionId("ok-123_AB")).not.toThrow();
    expect(() => validateSessionId("../bad")).toThrow(BundlePathError);
  });
});

import { describe, expect, it } from "vitest";
import { fingerprintDigest } from "../src/fingerprint.js";

describe("fingerprintDigest", () => {
  it("gives one digest for one value whatever order its keys were written in", () => {
    const written = fingerprintDigest({ order: 1, lines: [{ sku: "a", qty: 2 }], total: 20 });
    const reordered = fingerprintDigest({ total: 20, lines: [{ qty: 2, sku: "a" }], order: 1 });
    expect(written).toBe(reordered);
    expect(fingerprintDigest({ order: 1, total: 21 })).not.toBe(fingerprintDigest({ order: 1, total: 20 }));
  });
});

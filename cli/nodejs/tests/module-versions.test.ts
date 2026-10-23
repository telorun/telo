import { describe, expect, it } from "vitest";
import { readVersionDigests } from "../src/commands/module.js";

/** `telo module versions --digests` — what the hub's reconcile pass reads, one
 *  process per module instead of one per version. */
describe("readVersionDigests", () => {
  it("keeps the versions' order whatever order the digests arrive in", async () => {
    const delays: Record<string, number> = { "1.2.0": 20, "1.1.0": 0, "1.0.0": 10 };
    const result = await readVersionDigests(["1.2.0", "1.1.0", "1.0.0"], async (version) => {
      await new Promise((resolve) => setTimeout(resolve, delays[version]));
      return `sha256:${version}`;
    });

    expect(result).toEqual([
      { version: "1.2.0", digest: "sha256:1.2.0" },
      { version: "1.1.0", digest: "sha256:1.1.0" },
      { version: "1.0.0", digest: "sha256:1.0.0" },
    ]);
  });

  it("reports each version it could not read in its place, beside the readable ones", async () => {
    const result = await readVersionDigests(["1.2.0", "1.1.0", "1.0.0"], async (version) => {
      if (version === "1.1.0") return null;
      if (version === "1.0.0") throw new Error("registry answered 500");
      return `sha256:${version}`;
    });

    expect(result).toEqual([
      { version: "1.2.0", digest: "sha256:1.2.0" },
      { version: "1.1.0", error: "version not found" },
      { version: "1.0.0", error: "registry answered 500" },
    ]);
  });

  it("bounds the requests in flight", async () => {
    const versions = Array.from({ length: 30 }, (_, i) => `1.0.${i}`);
    let inFlight = 0;
    let peak = 0;
    await readVersionDigests(versions, async (version) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return `sha256:${version}`;
    });

    expect(peak).toBe(8);
  });
});

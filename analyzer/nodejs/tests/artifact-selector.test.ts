import { describe, expect, it } from "vitest";
import {
  describeSelector,
  selectorFromQualifiers,
  selectorKey,
  selectorMatches,
} from "../src/artifact-selector.js";
import { layerDigestKey } from "../src/release/payload-digest.js";

describe("the abi axis", () => {
  const selector = selectorFromQualifiers("node", { os: "linux", arch: "amd64", abi: "NODE-137" });

  it("takes part in the canonical key, the description and matching", () => {
    expect(selectorKey(selector)).toBe("abi=node-137;arch=amd64;format=node;os=linux");
    expect(describeSelector(selector)).toBe("node (linux/amd64/node-137)");
    expect(selectorMatches(selector, { os: "linux", arch: "amd64", abi: "node-137" })).toBe(true);
    expect(selectorMatches(selector, { os: "linux", arch: "amd64", abi: "node-141" })).toBe(false);
    // Undetermined abi matches only a selector that does not constrain it.
    expect(selectorMatches(selector, { os: "linux", arch: "amd64" })).toBe(false);
  });

  // Ledger keys are committed; a selector without abi must render as it did.
  it("leaves the ledger key of a selector without abi unchanged, and appends its own", () => {
    const gnu = selectorFromQualifiers("napi", { os: "linux", arch: "amd64", libc: "gnu" });
    expect(layerDigestKey("controller", gnu)).toBe("controller/napi+linux+amd64+gnu");
    expect(layerDigestKey("controller", { ...gnu, abi: "node-137" })).toBe(
      "controller/napi+linux+amd64+gnu+node-137",
    );
  });
});

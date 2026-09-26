import { describe, expect, it } from "vitest";
import { selectVersion } from "../src/select-version.js";
import type { VersionCatalog } from "../src/version-catalog.js";
import { requirementsFor } from "./router-harness.js";

const OWNER = "file:///ws/app/telo.yaml";
const LIB = "oci://ghcr.io/telorun/lib@1.0.0";
const catalog: VersionCatalog = {
  bundled: "0.102.0",
  source: "registry",
  offered: ["0.104.0", "0.103.0", "0.101.0", "0.100.0"].map((version) => ({
    version,
    tarball: "t",
    integrity: "sha512-x",
  })),
  unoffered: { "0.99.0": "below-protocol-floor" },
};

describe("selecting the telo version for a module", () => {
  it("rule 1 — takes the lowest version the owner's range and its closure accept", () => {
    const requirements = requirementsFor(OWNER, [OWNER], [
      { module: OWNER, text: ">=0.100.0", min: "0.100.0" },
      { module: LIB, text: ">=0.101.0", min: "0.101.0" },
    ]);
    expect(selectVersion({ catalog, requirements })).toEqual({
      version: "0.101.0",
      reason: { kind: "owner-range", range: ">=0.100.0" },
    });
  });

  it("rule 2 — keeps the bundled version when the closure accepts it, else the lowest it accepts", () => {
    const accepts = requirementsFor(OWNER, [OWNER], [{ module: LIB, text: ">=0.101.0", min: "0.101.0" }]);
    expect(selectVersion({ catalog, requirements: accepts })).toEqual({
      version: "0.102.0",
      reason: { kind: "bundled" },
    });
    const above = requirementsFor(OWNER, [OWNER], [{ module: LIB, text: ">=0.103.0", min: "0.103.0" }]);
    expect(selectVersion({ catalog, requirements: above })).toEqual({
      version: "0.103.0",
      reason: { kind: "closure-range", ranges: [">=0.103.0"] },
    });
  });

  it("rule 3 — falls back to the bundled version when nothing satisfies the closure", () => {
    const requirements = requirementsFor(OWNER, [OWNER], [
      { module: OWNER, text: ">=0.200.0", min: "0.200.0" },
    ]);
    expect(selectVersion({ catalog, requirements })).toEqual({
      version: "0.102.0",
      reason: { kind: "unsatisfiable", ranges: [">=0.200.0"] },
    });
  });

  it("honours an offered pin whatever the ranges say", () => {
    const requirements = requirementsFor(OWNER, [OWNER], [{ module: OWNER, text: ">=0.104.0", min: "0.104.0" }]);
    expect(selectVersion({ catalog, requirements, pin: "0.100.0" })).toEqual({
      version: "0.100.0",
      reason: { kind: "pinned" },
    });
  });

  // A bundled development build `0.102.0+unreleased` ties with a published
  // 0.102.0 by precedence: the published one is the lower candidate, and only
  // rule 2's "keep the bundled version" picks the bundled one.
  it("prefers the published engine on a precedence tie, except rule 2's bundled choice", () => {
    const tie: VersionCatalog = {
      ...catalog,
      bundled: "0.102.0+unreleased",
      offered: [{ version: "0.102.0", tarball: "t", integrity: "sha512-x" }],
    };
    const floor = requirementsFor(OWNER, [OWNER], [{ module: OWNER, text: ">=0.102.0", min: "0.102.0" }]);
    expect(selectVersion({ catalog: tie, requirements: floor })).toMatchObject({ version: "0.102.0" });
    expect(selectVersion({ catalog: tie })).toMatchObject({ version: "0.102.0+unreleased", reason: { kind: "bundled" } });
  });

  it("takes a pin as an exact engine identity", () => {
    const tie: VersionCatalog = {
      ...catalog,
      bundled: "0.102.0+unreleased",
      offered: [{ version: "0.102.0", tarball: "t", integrity: "sha512-x" }],
    };
    expect(selectVersion({ catalog: tie, pin: "0.102.0" })).toMatchObject({ version: "0.102.0" });
    expect(selectVersion({ catalog: tie, pin: "0.102.0+unreleased" })).toMatchObject({ version: "0.102.0+unreleased" });
    expect(selectVersion({ catalog: tie, pin: "0.102.0+other" })).toEqual({
      refused: { pin: "0.102.0+other", reason: "unpublished" },
    });
  });

  it("refuses a pin it does not offer, naming why", () => {
    expect(selectVersion({ catalog, pin: "0.99.0" })).toEqual({
      refused: { pin: "0.99.0", reason: "below-protocol-floor" },
    });
    expect(selectVersion({ catalog, pin: "0.98.0" })).toEqual({
      refused: { pin: "0.98.0", reason: "unpublished" },
    });
  });
});

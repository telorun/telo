import { describe, expect, it } from "vitest";

import { evaluateRange, loadRange, readModuleRequirements } from "../src/runtime-range.js";

const module = (doc: Record<string, unknown>) =>
  readModuleRequirements({ kind: "Telo.Library", metadata: { name: "Geocode", version: "1.2.1" }, ...doc });
const load = (doc: Record<string, unknown>) => loadRange(module(doc));
const telo = (raw: string) => load({ requires: { telo: raw } });

describe("evaluateRange", () => {
  it("passes inside the range and fails outside it", () => {
    expect(evaluateRange(telo(">=0.80.0"), "0.80.0").satisfied).toBe(true);
    expect(evaluateRange(telo(">=0.80.0"), "0.76.0")).toMatchObject({
      satisfied: false,
      direction: "newer",
      bound: ">=0.80.0",
    });
  });

  // Bootstrap: everything published before the mechanism existed declares
  // nothing, and none of it uses syntax that did not yet exist.
  it("treats an absent declaration as no requirement", () => {
    expect(evaluateRange(load({}), "0.1.0").satisfied).toBe(true);
  });

  // The guard is a PARSE, not a shape test: `0.76` and `2024.1` look like
  // versions and are not three-part ones, so a leading-digit test would fail
  // them CLOSED and gate every module on a number nothing could compare.
  it("treats a running version it cannot parse as satisfied", () => {
    for (const running of [undefined, "0.76", "2024.1", "dev", "v", ""]) {
      expect(evaluateRange(telo(">=0.80.0"), running).satisfied, String(running)).toBe(true);
    }
  });

  it("meets '>=unreleased' only with a build of the pending release", () => {
    expect(evaluateRange(telo(">=unreleased"), "0.120.3")).toMatchObject({
      satisfied: false,
      direction: "newer",
      bound: ">=unreleased",
      running: "0.120.3",
    });
    expect(evaluateRange(telo(">=unreleased"), "0.121.0+unreleased").satisfied).toBe(true);
  });

  // Build metadata leaves precedence alone, so an unreleased build is compared
  // by its version on every numeric bound.
  it("compares an unreleased build by its version", () => {
    expect(evaluateRange(telo(">=0.122.0"), "0.121.0+unreleased").satisfied).toBe(false);
    expect(evaluateRange(telo(">=0.121.0"), "0.121.0+unreleased").satisfied).toBe(true);
  });

  // The editor has no host to speak for, so an axis with no supplied version is
  // skipped rather than guessed — but enforced once a host reports one.
  it("judges a host axis only against a supplied version", () => {
    const range = load({ requires: { host: { node: ">=20.0.0" } } });
    expect(evaluateRange(range, "0.1.0").satisfied).toBe(true);
    expect(evaluateRange(range, "0.1.0", { node: "18.19.0" })).toMatchObject({
      satisfied: false,
      key: "node",
      running: "18.19.0",
    });
  });

  // `telo` first: a module using a later host axis also declares the telo that
  // defined it, so the skew is reported before the axis.
  it("reports the telo skew before any host axis", () => {
    const range = load({ requires: { telo: ">=0.90.0", host: { node: ">=99.0.0" } } });
    expect(evaluateRange(range, "0.76.0", { node: "20.0.0" })).toMatchObject({ key: "telo" });
  });

  it("reports a runtime above a ceiling as needing an older one", () => {
    expect(evaluateRange(telo(">=0.121.0 <0.122.0"), "0.122.0")).toMatchObject({
      satisfied: false,
      direction: "older",
      bound: "<0.122.0",
      source: { from: "requires" },
    });
  });
});

describe("loadRange", () => {
  const restricted = {
    requires: { telo: ">=0.121.0" },
    restrictions: [
      { versions: ">=1.2.0", requires: { telo: "<0.122.0" }, reason: "Lookup never returns." },
      { versions: "<=1.2.0", requires: { host: { node: "<24.0.0" } }, reason: "Crashes on Node 24." },
    ],
  };

  // Only the entries covering the version itself narrow its load range.
  it("narrows the version's own requires by its own covering entries", () => {
    const range = load(restricted);
    expect(evaluateRange(range, "0.122.0")).toMatchObject({
      direction: "older",
      source: { from: "restriction", version: "1.2.1", index: 0, reason: "Lookup never returns." },
    });
    expect(evaluateRange(range, "0.121.0", { node: "24.0.0" }).satisfied).toBe(true);
  });

  it("applies an entry without versions to the declaring doc", () => {
    const range = load({
      requires: { telo: ">=0.121.0" },
      restrictions: [{ requires: { telo: ">=unreleased" }, reason: "Needs the next kernel." }],
    });
    expect(evaluateRange(range, "0.121.0")).toMatchObject({
      direction: "newer",
      bound: ">=unreleased",
      source: { from: "restriction", index: 0 },
    });
  });
});

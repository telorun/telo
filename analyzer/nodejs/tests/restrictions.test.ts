import { describe, expect, it } from "vitest";

import { readRestrictions, restrictionCovers } from "../src/restrictions.js";
import { validateRequires } from "../src/validate-requires.js";
import { DiagnosticSeverity } from "../src/types.js";

function geocode(restrictions: unknown, version = "1.2.1") {
  return {
    kind: "Telo.Library",
    metadata: { name: "Geocode", version, source: "file:///geocode/telo.yaml", module: "Geocode" },
    requires: { telo: ">=0.121.0" },
    restrictions,
  } as never;
}

describe("restrictionCovers", () => {
  const entry = (versions: string | undefined, version = "1.2.1") =>
    readRestrictions(
      geocode([{ ...(versions ? { versions } : {}), requires: { telo: "<0.122.0" }, reason: "r" }], version) as never,
    ).entries[0]!;

  // A range with no upper bound runs through the declaring version, whatever
  // the module track later makes it.
  it("closes a range without an upper bound at the declaring version", () => {
    const open = entry(">=1.2.0");
    expect(["1.1.0", "1.2.0", "1.2.1", "1.3.0"].map((v) => restrictionCovers(open, "1.2.1", v))).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it("covers no later version than an explicit upper bound", () => {
    const closed = entry("<=1.2.0");
    expect(restrictionCovers(closed, "1.2.1", "1.2.0")).toBe(true);
    expect(restrictionCovers(closed, "1.2.1", "1.2.1")).toBe(false);
  });

  it("covers only the declaring doc without versions", () => {
    const own = entry(undefined);
    expect(restrictionCovers(own, "1.2.1", "1.2.1")).toBe(true);
    expect(restrictionCovers(own, "1.2.1", "1.2.0")).toBe(false);
  });
});

describe("RESTRICTIONS_INVALID", () => {
  // The plan's refused example, entry for entry.
  it("refuses each malformed or unusable entry, and enforces none of them", () => {
    const diagnostics = validateRequires([
      geocode([
        { versions: "<=1.3.0", requires: { telo: "<0.122.0" }, reason: "Lookup never returns on telo 0.122.0 and later." },
        { versions: "<=1.2.1", requires: { telo: "<0.121.0" }, reason: "Broken everywhere." },
        { versions: "<=1.2.0", requires: { telo: "<0.122.0" } },
        { requires: {}, reason: "Held back." },
        { requires: { host: { node: ">=unreleased" } }, reason: "Needs the next Node." },
      ]),
    ]);
    expect(diagnostics.map((d) => [d.code, d.severity, (d.data as any).path, d.message])).toEqual([
      [
        "RESTRICTIONS_INVALID",
        DiagnosticSeverity.Error,
        "restrictions[0].versions",
        "restrictions[0].versions '<=1.3.0' reaches past this module's version 1.2.1; an entry covers " +
          "only this version and earlier ones. Leave the upper bound off to cover through this version.",
      ],
      [
        "RESTRICTIONS_INVALID",
        DiagnosticSeverity.Error,
        "restrictions[1]",
        "restrictions[1] leaves 1.2.1 usable by no telo: requires.telo '>=0.121.0' and '<0.121.0' do " +
          "not overlap. Deprecate the module instead.",
      ],
      [
        "RESTRICTIONS_INVALID",
        DiagnosticSeverity.Error,
        "restrictions[2]",
        "restrictions[2] has no reason; say what breaks, so whoever is held back knows why.",
      ],
      [
        "RESTRICTIONS_INVALID",
        DiagnosticSeverity.Error,
        "restrictions[3].requires",
        "restrictions[3].requires states no bound.",
      ],
      [
        "RESTRICTIONS_INVALID",
        DiagnosticSeverity.Error,
        "restrictions[4].requires.host.node",
        "restrictions[4].requires.host.node '>=unreleased': unreleased names a telo release and is " +
          "allowed only as a telo floor.",
      ],
    ]);
  });

  // Not the consumer's to fix, but not silent: dropped, and said so.
  it("warns on a dependency's malformed entry", () => {
    const diagnostics = validateRequires([geocode([{ requires: { telo: "<0.1.0" } }])], {
      entryModules: new Set(["App"]),
    });
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["RESTRICTIONS_INVALID", DiagnosticSeverity.Warning],
    ]);
    expect(diagnostics[0]?.message).toMatch(/not enforced here/);
  });
});

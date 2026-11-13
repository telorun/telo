import { describe, expect, it } from "vitest";
import { parseFragment } from "../src/fragment.js";
import { EMPTY_LEDGER, type Ledger, type UnitLayers } from "../src/ledger.js";
import { planRelease, recordRelease, type UnitEvidence } from "../src/release-plan.js";

const npm = (digest: string): UnitLayers => ({ ecosystems: { npm: { ".": digest } } });

function unit(over: Partial<UnitEvidence> & { key: string }): UnitEvidence {
  return {
    version: "1.0.0",
    layers: npm("sha256-same"),
    imports: [],
    inlines: new Map(),
    ownFilesChanged: false,
    ...over,
  };
}

function ledger(entries: Record<string, { version: string; layers?: UnitLayers; registry?: string; candidate?: { version: string; layers: UnitLayers } }>): Ledger {
  return {
    units: new Map(
      Object.entries(entries).map(([key, entry]) => [key, { layers: npm("sha256-same"), ...entry }]),
    ),
  };
}

const fragment = (text: string, source = ".changes/pending/f.yaml") => parseFragment(text, source);

describe("the digest decides WHETHER", () => {
  it("plans nothing when every payload matches the ledger", () => {
    const plan = planRelease({
      units: [unit({ key: "packages/a" })],
      ledger: ledger({ "packages/a": { version: "1.0.0" } }),
      fragments: [],
    });
    expect(plan.units).toEqual([]);
  });

  it("does not treat a never-published unit as drift", () => {
    const plan = planRelease({
      units: [unit({ key: "packages/new", layers: npm("sha256-x") })],
      ledger: EMPTY_LEDGER,
      fragments: [],
    });
    expect(plan.units).toEqual([]);
  });

  it("refuses a working version the ledger does not record", () => {
    const plan = planRelease({
      units: [unit({ key: "packages/a", layers: npm("sha256-moved") })],
      ledger: ledger({ "packages/a": { version: "0.9.3", layers: npm("sha256-old") } }),
      fragments: [],
    });
    expect(plan.diagnostics.map((d) => d.code)).toContain("LEDGER_VERSION_MISMATCH");
  });

  it("bumps a drifted unit with no attribution as a patch, and says so", () => {
    const plan = planRelease({
      units: [unit({ key: "packages/a", version: "0.9.3", layers: npm("sha256-moved") })],
      ledger: ledger({ "packages/a": { version: "0.9.3", layers: npm("sha256-old") } }),
      fragments: [],
    });
    expect(plan.units[0]).toMatchObject({ from: "0.9.3", to: "0.9.4", level: "patch" });
    expect(plan.units[0]!.reasons).toEqual([{ kind: "unattributed" }]);
    expect(plan.units[0]!.changed).toEqual([{ path: ["npm", "."], before: "sha256-old", after: "sha256-moved" }]);
  });
});

describe("edges decide AT WHAT LEVEL", () => {
  it("mirrors a dependency's level onto a dependent whose payload inlined it", () => {
    const plan = planRelease({
      units: [
        unit({ key: "lib", version: "0.13.1" }),
        unit({
          key: "bundle",
          version: "0.7.0",
          layers: npm("sha256-moved"),
          inlines: new Map([["lib", ["lib/src/query.ts"]]]),
        }),
      ],
      ledger: ledger({
        lib: { version: "0.13.1" },
        bundle: { version: "0.7.0", layers: npm("sha256-old") },
      }),
      fragments: [fragment("units:\n  lib: Added\nbody: A thing.")],
    });
    const byKey = Object.fromEntries(plan.units.map((u) => [u.key, u]));
    expect(byKey.lib).toMatchObject({ to: "0.14.0", level: "minor" });
    expect(byKey.bundle).toMatchObject({ to: "0.8.0", level: "minor" });
    expect(byKey.bundle!.reasons).toContainEqual({ kind: "inlines", unit: "lib", files: ["lib/src/query.ts"] });
  });

  it("bumps an importer even when its current digest has not moved", () => {
    const plan = planRelease({
      units: [unit({ key: "lib", version: "0.13.1" }), unit({ key: "app", version: "0.4.0", imports: ["lib"] })],
      ledger: ledger({ lib: { version: "0.13.1" }, app: { version: "0.4.0" } }),
      fragments: [fragment("units:\n  lib: Fixed\nbody: A fix.")],
    });
    const app = plan.units.find((u) => u.key === "app");
    expect(app).toMatchObject({ to: "0.4.1", level: "patch" });
    expect(app!.reasons).toContainEqual({ kind: "imports", unit: "lib" });
  });

  it("does not attribute an inline edge to a dependency whose payload did not move", () => {
    const plan = planRelease({
      units: [
        unit({ key: "lib", version: "0.13.1" }),
        unit({ key: "bundle", version: "0.7.0", inlines: new Map([["lib", ["lib/src/query.ts"]]]) }),
      ],
      ledger: ledger({ lib: { version: "0.13.1" }, bundle: { version: "0.7.0" } }),
      fragments: [fragment("units:\n  lib: Fixed\nbody: A fix.")],
    });
    expect(plan.units.map((u) => u.key)).toEqual(["lib"]);
  });

  it("bumps a unit whose payload holds another unit's version location, at its level", () => {
    // An image whose build context carries a library's package.json moves when
    // the library's version does; the unit's own version files are no edge.
    const plan = planRelease({
      units: [
        unit({ key: "packages/lib", versionFiles: ["packages/lib/package.json"] }),
        unit({
          key: "apps/image",
          versionFiles: ["apps/image/package.json"],
          payloadFiles: ["apps/image/package.json", "packages/lib/package.json", "packages/lib/index.js"],
        }),
      ],
      ledger: ledger({ "packages/lib": { version: "1.0.0" }, "apps/image": { version: "1.0.0" } }),
      fragments: [fragment("units:\n  packages/lib: Added\nbody: A thing.")],
    });
    expect(plan.units.map((u) => [u.key, u.level])).toEqual([
      ["packages/lib", "minor"],
      ["apps/image", "minor"],
    ]);
    expect(plan.units[1]!.reasons).toEqual([
      { kind: "version-location", unit: "packages/lib", files: ["packages/lib/package.json"] },
    ]);
  });

  it("takes the maximum level over several paths", () => {
    const plan = planRelease({
      units: [unit({ key: "a" }), unit({ key: "b" }), unit({ key: "c", imports: ["a", "b"] })],
      ledger: ledger({ a: { version: "1.0.0" }, b: { version: "1.0.0" }, c: { version: "1.0.0" } }),
      fragments: [
        fragment("units:\n  a: Fixed\nbody: patch.", ".changes/pending/a.yaml"),
        fragment("units:\n  b: Added\nbody: minor.", ".changes/pending/b.yaml"),
      ],
    });
    expect(plan.units.find((u) => u.key === "c")).toMatchObject({ level: "minor" });
  });

  it("propagates through an unattributed bump", () => {
    const plan = planRelease({
      units: [unit({ key: "a", layers: npm("sha256-moved") }), unit({ key: "b", imports: ["a"] })],
      ledger: ledger({ a: { version: "1.0.0", layers: npm("sha256-old") }, b: { version: "1.0.0" } }),
      fragments: [],
    });
    expect(plan.units.map((u) => u.key)).toEqual(["a", "b"]);
  });

  it("orders the plan so a dependency precedes its dependents", () => {
    const plan = planRelease({
      units: [unit({ key: "z", imports: ["a"] }), unit({ key: "a" })],
      ledger: ledger({ a: { version: "1.0.0" }, z: { version: "1.0.0" } }),
      fragments: [fragment("units:\n  a: Fixed\nbody: fix.")],
    });
    expect(plan.units.map((u) => u.key)).toEqual(["a", "z"]);
  });
});

describe("groups and maxBump", () => {
  it("releases every member at the highest level any member needs, at one version", () => {
    const plan = planRelease({
      units: [unit({ key: "kernel", version: "0.5.0" }), unit({ key: "cli", version: "0.5.0" }), unit({ key: "cel", version: "0.5.0" })],
      ledger: ledger({ kernel: { version: "0.5.0" }, cli: { version: "0.5.0" }, cel: { version: "0.5.0" } }),
      fragments: [fragment("units:\n  kernel: Added\nbody: A thing.")],
      groups: new Map([["telo", ["kernel", "cli"]]]),
    });
    expect(plan.units.map((u) => [u.key, u.to, u.group])).toEqual([
      ["cli", "0.6.0", "telo"],
      ["kernel", "0.6.0", "telo"],
    ]);
    expect(plan.units[0]!.reasons).toEqual([{ kind: "group", group: "telo" }]);
  });

  it("refuses a level above a unit's maxBump, naming why it was needed", () => {
    const plan = planRelease({
      units: [unit({ key: "a", maxBump: "minor" }), unit({ key: "b" })],
      ledger: ledger({ a: { version: "1.0.0" }, b: { version: "1.0.0" } }),
      fragments: [fragment("units:\n  a: Removed\n  b: Changed\nbody: gone.")],
    });
    expect(plan.diagnostics.map((d) => d.code)).toEqual(["MAX_BUMP_EXCEEDED"]);
    expect(plan.diagnostics[0]!.message).toContain("a needs a major bump, above its maxBump of minor");
    expect(plan.units.find((u) => u.key === "b")).toMatchObject({ to: "2.0.0" });
  });
});

describe("candidates", () => {
  const evidence = (layers: UnitLayers, version: string, candidate?: { version: string; layers: UnitLayers }) => ({
    units: [unit({ key: "a", version, layers })],
    ledger: ledger({ a: { version: "1.0.0", layers: npm("sha256-old"), ...(candidate ? { candidate } : {}) } }),
    fragments: [fragment("units:\n  a: Added\nbody: A thing.")],
  });

  it("versions the first candidate <final>-<id>.1 and consumes no fragment", () => {
    const plan = planRelease(evidence(npm("sha256-new"), "1.0.0"), { candidate: "rc" });
    expect(plan.units.map((u) => u.to)).toEqual(["1.1.0-rc.1"]);
    expect(plan.fragments).toEqual([]);
    expect(plan.candidate).toBe("rc");
  });

  it("plans the same candidate again from one ledger, so nothing moves", () => {
    const record = { version: "1.1.0-rc.1", layers: npm("sha256-new") };
    expect(planRelease(evidence(npm("sha256-new"), "1.1.0-rc.1", record), { candidate: "rc" }).units).toEqual([]);
  });

  it("raises k only when a layer differs from the candidate record", () => {
    const record = { version: "1.1.0-rc.1", layers: npm("sha256-new") };
    const plan = planRelease(evidence(npm("sha256-newer"), "1.1.0-rc.1", record), { candidate: "rc" });
    expect(plan.units.map((u) => u.to)).toEqual(["1.1.0-rc.2"]);
  });

  it("shares k within a group", () => {
    const plan = planRelease(
      {
        units: [
          unit({ key: "a", version: "1.1.0-rc.2", layers: npm("sha256-a2") }),
          unit({ key: "b", version: "1.1.0-rc.1", layers: npm("sha256-b1") }),
        ],
        ledger: ledger({
          a: { version: "1.0.0", candidate: { version: "1.1.0-rc.2", layers: npm("sha256-a2") } },
          b: { version: "1.0.0", candidate: { version: "1.1.0-rc.1", layers: npm("sha256-b1") } },
        }),
        fragments: [fragment("units:\n  a: Added\nbody: A thing.")],
        groups: new Map([["line", ["a", "b"]]]),
      },
      { candidate: "rc" },
    );
    expect(plan.units.map((u) => [u.key, u.to])).toEqual([["b", "1.1.0-rc.2"]]);
  });

  it("plans the final from the final entry, and the final removes every candidate record", () => {
    const record = { version: "1.1.0-rc.2", layers: npm("sha256-new") };
    const plan = planRelease(evidence(npm("sha256-new"), "1.1.0-rc.2", record));
    expect(plan.units.map((u) => [u.from, u.to])).toEqual([["1.1.0-rc.2", "1.1.0"]]);
    expect(plan.fragments).toEqual([".changes/pending/f.yaml"]);

    const before = ledger({
      a: { version: "1.0.0", candidate: record },
      other: { version: "2.0.0", candidate: { version: "2.1.0-rc.1", layers: npm("x") } },
    });
    const after = recordRelease(before, plan, new Map([["a", { layers: npm("sha256-final") }]]));
    expect(after.units.get("a")).toEqual({ version: "1.1.0", layers: npm("sha256-final") });
    expect(after.units.get("other")).toEqual({ version: "2.0.0", layers: npm("sha256-same") });
  });

  it("records a candidate beside the untouched final entry", () => {
    const plan = planRelease(evidence(npm("sha256-new"), "1.0.0"), { candidate: "rc" });
    const after = recordRelease(evidence(npm("x"), "1.0.0").ledger, plan, new Map([["a", { layers: npm("sha256-rc") }]]));
    expect(after.units.get("a")).toEqual({
      version: "1.0.0",
      layers: npm("sha256-old"),
      candidate: { version: "1.1.0-rc.1", layers: npm("sha256-rc") },
    });
  });
});

describe("what makes a plan inconsistent", () => {
  it("refuses a fragment naming a unit that does not exist", () => {
    const plan = planRelease({
      units: [unit({ key: "modules/sql" })],
      ledger: EMPTY_LEDGER,
      fragments: [fragment("units:\n  sql: Fixed\nbody: a fix.")],
    });
    expect(plan.diagnostics.map((d) => d.code)).toEqual(["FRAGMENT_UNKNOWN_UNIT"]);
  });

  it("refuses digests taken against another registry base, per unit", () => {
    const plan = planRelease({
      units: [unit({ key: "a", registry: "oci://other/org" }), unit({ key: "b", registry: "oci://example/org" })],
      ledger: ledger({
        a: { version: "1.0.0", registry: "oci://example/org" },
        b: { version: "1.0.0", registry: "oci://example/org" },
      }),
      fragments: [],
    });
    const mismatches = plan.diagnostics.filter((d) => d.code === "LEDGER_REGISTRY_MISMATCH");
    expect(mismatches.map((d) => d.message.split(":")[0])).toEqual(["a"]);
  });

  it("refuses a unit whose version locations disagree", () => {
    const plan = planRelease({
      units: [
        unit({
          key: "engine",
          versionReadings: [
            { file: "engine/nodejs/package.json", value: "1.0.0" },
            { file: "engine/rust/Cargo.toml", value: "0.9.0" },
          ],
        }),
      ],
      ledger: ledger({ engine: { version: "1.0.0" } }),
      fragments: [],
    });
    expect(plan.diagnostics.map((d) => d.code)).toEqual(["UNIT_VERSION_MISMATCH"]);
    expect(plan.diagnostics[0]!.message).toContain("engine/rust/Cargo.toml holds 0.9.0");
  });

  it("asks ONCE for a changelog entry, as a warning, naming every unit whose own files changed", () => {
    const plan = planRelease({
      units: [unit({ key: "a", ownFilesChanged: true }), unit({ key: "b", ownFilesChanged: true })],
      ledger: EMPTY_LEDGER,
      fragments: [],
    });
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", code: "CHANGELOG_ENTRY_REQUESTED" }),
    ]);
    expect(plan.diagnostics[0]!.message).toContain("2 unit(s)");
    expect(plan.diagnostics[0]!.message).toContain("a, b");
  });

  it("does not ask for prose from a unit that only drifted", () => {
    const plan = planRelease({
      units: [unit({ key: "a", layers: npm("sha256-moved") })],
      ledger: ledger({ a: { version: "1.0.0", layers: npm("sha256-old") } }),
      fragments: [],
    });
    expect(plan.diagnostics).toEqual([]);
    expect(plan.units).toHaveLength(1);
  });
});

describe("fragments", () => {
  it("maps several units in one file", () => {
    const parsed = fragment("units:\n  a: Fixed\n  b: Added\nbody: one change.");
    expect([...parsed.units]).toEqual([
      ["a", "Fixed"],
      ["b", "Added"],
    ]);
  });

  it("reads a fragment written before units, naming them under modules:", () => {
    expect([...fragment("modules:\n  modules/sql: Fixed\nbody: a fix.").units]).toEqual([["modules/sql", "Fixed"]]);
  });

  it("refuses an unknown kind rather than defaulting it", () => {
    expect(() => fragment("units:\n  a: Tweaked\nbody: x.")).toThrow(/not a release kind/);
  });
});

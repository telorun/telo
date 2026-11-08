import { describe, expect, it } from "vitest";
import {
  buildImportUpgrades,
  createVersionCompatibility,
  markVersionCompatibility,
  noneRunnableReason,
  selectCompatibleVersion,
  uncheckedVersionCompatibility,
  type ModuleVersion,
  type ModuleVersionLookup,
} from "../src/import-upgrades/index.js";

const TIMER = "oci://ghcr.io/telorun/timer";

const versions: ModuleVersion[] = [
  { version: "2.2.0" },
  { version: "2.1.0" },
  { version: "2.0.0" },
];

const listTimer: ModuleVersionLookup = async (baseRef) =>
  baseRef === TIMER ? versions : [];

/** A manifest declaring the telo surface it needs. */
function manifest(requires?: string): string {
  return [
    "kind: Telo.Library",
    "metadata:",
    "  name: timer",
    ...(requires ? ["requires:", `  telo: "${requires}"`] : []),
    "",
  ].join("\n");
}

/** Reads that answer per version, and count what was asked. */
function reader(byVersion: Record<string, string | null>) {
  const asked: string[] = [];
  return {
    asked,
    read: async (_baseRef: string, version: string) => {
      asked.push(version);
      return byVersion[version] ?? null;
    },
  };
}

const importsText = [
  "kind: Telo.Application",
  "metadata:",
  "  name: App",
  "imports:",
  `  Timer: ${TIMER}@2.0.0`,
  "",
].join("\n");

describe("createVersionCompatibility", () => {
  it("reads the declared requirement and answers per version", async () => {
    const { read } = reader({
      "2.2.0": manifest(">=9.0.0"),
      "2.1.0": manifest(">=0.1.0"),
      "2.0.0": manifest(),
    });
    const isCompatible = createVersionCompatibility(read, "0.79.0");

    expect(await isCompatible(TIMER, "2.2.0")).toMatchObject({ compatibility: "too-new" });
    expect(await isCompatible(TIMER, "2.1.0")).toMatchObject({ compatibility: "yes" });
    // Declaring nothing is compatible — the bootstrap rule.
    expect(await isCompatible(TIMER, "2.0.0")).toMatchObject({ compatibility: "yes" });
  });

  it("answers unknown for a manifest it cannot read, and never blocks", async () => {
    const isCompatible = createVersionCompatibility(async () => {
      throw new Error("offline");
    }, "0.79.0");
    expect(await isCompatible(TIMER, "2.2.0")).toMatchObject({ compatibility: "unknown" });

    const selection = await selectCompatibleVersion(TIMER, versions, "2.0.0", isCompatible);
    expect(selection.best?.version).toBe("2.2.0");
    expect(selection.heldBack).toBeNull();
  });

  it("re-asks after a failed read, so one offline moment does not disable the check", async () => {
    let attempt = 0;
    const isCompatible = createVersionCompatibility(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("offline");
      return manifest(">=9.0.0");
    }, "0.79.0");

    // The verdict is what is immutable, not the network. Caching `unknown`
    // would leave the UI reading as though every version had been cleared.
    expect(await isCompatible(TIMER, "2.2.0")).toMatchObject({ compatibility: "unknown" });
    expect(await isCompatible(TIMER, "2.2.0")).toMatchObject({ compatibility: "too-new" });
    // ...and the decided verdict IS cached from then on.
    expect(await isCompatible(TIMER, "2.2.0")).toMatchObject({ compatibility: "too-new" });
    expect(attempt).toBe(2);
  });

  it("asks for each version once, however many times it is checked", async () => {
    const { asked, read } = reader({ "2.2.0": manifest(">=0.1.0") });
    const isCompatible = createVersionCompatibility(read, "0.79.0");

    await Promise.all([
      isCompatible(TIMER, "2.2.0"),
      isCompatible(TIMER, "2.2.0"),
      isCompatible(TIMER, "2.2.0"),
    ]);
    await isCompatible(TIMER, "2.2.0");

    expect(asked).toEqual(["2.2.0"]);
  });
});

describe("selectCompatibleVersion", () => {
  it("stops at the newest hostable candidate and reports what it held back", async () => {
    const { asked, read } = reader({
      "2.2.0": manifest(">=9.0.0"),
      "2.1.0": manifest(">=0.1.0"),
    });
    const selection = await selectCompatibleVersion(
      TIMER,
      versions,
      "2.0.0",
      createVersionCompatibility(read, "0.79.0"),
    );

    expect(selection.best?.version).toBe("2.1.0");
    expect(selection.heldBack).toMatchObject({ version: "2.2.0", reason: "too-new" });
    // Newest-first with a short-circuit: 2.0.0 is never asked about.
    expect(asked).toEqual(["2.2.0", "2.1.0"]);
  });

  it("costs one read when the newest version is hostable", async () => {
    const { asked, read } = reader({ "2.2.0": manifest(">=0.1.0") });
    const selection = await selectCompatibleVersion(
      TIMER,
      versions,
      "2.0.0",
      createVersionCompatibility(read, "0.79.0"),
    );

    expect(selection.best?.version).toBe("2.2.0");
    expect(asked).toEqual(["2.2.0"]);
  });

  it("selects nothing when every newer version needs a newer telo", async () => {
    const { read } = reader({
      "2.2.0": manifest(">=9.0.0"),
      "2.1.0": manifest(">=9.0.0"),
    });
    const selection = await selectCompatibleVersion(
      TIMER,
      versions,
      "2.0.0",
      createVersionCompatibility(read, "0.79.0"),
    );

    expect(selection.best).toBeNull();
    expect(selection.heldBack).toMatchObject({ version: "2.2.0", reason: "too-new" });
  });

  it("keeps 'cannot read the requirement' apart from 'requires a newer telo'", async () => {
    const malformed = ["kind: Telo.Library", "metadata:", "  name: timer", "requires:", "  telo: 7", ""].join("\n");
    const { read } = reader({ "2.2.0": malformed, "2.1.0": manifest(">=0.1.0") });
    const selection = await selectCompatibleVersion(
      TIMER,
      versions,
      "2.0.0",
      createVersionCompatibility(read, "0.79.0"),
    );

    expect(selection.best?.version).toBe("2.1.0");
    expect(selection.heldBack).toMatchObject({ version: "2.2.0", reason: "unreadable" });
  });

  it("never walks backwards from the current version", async () => {
    const { read } = reader({ "2.2.0": manifest(">=9.0.0") });
    const selection = await selectCompatibleVersion(
      TIMER,
      versions,
      "2.1.0",
      createVersionCompatibility(read, "0.79.0"),
    );

    expect(selection.best).toBeNull();
    expect(selection.heldBack).toMatchObject({ version: "2.2.0", reason: "too-new" });
  });
});

describe("markVersionCompatibility", () => {
  it("marks every version, including ones no automatic pick would reach", async () => {
    const { read } = reader({
      "2.2.0": manifest(">=9.0.0"),
      "2.1.0": manifest(">=0.1.0"),
      "2.0.0": manifest(">=9.0.0"),
    });
    const marked = await markVersionCompatibility(
      TIMER,
      versions,
      createVersionCompatibility(read, "0.79.0"),
    );

    expect(marked.map((m) => [m.version, m.compatibility])).toEqual([
      ["2.2.0", "too-new"],
      ["2.1.0", "yes"],
      ["2.0.0", "too-new"],
    ]);
    expect(noneRunnableReason(marked)).toBeNull();
  });

  it("recognises a list where nothing can run", async () => {
    const { read } = reader({
      "2.2.0": manifest(">=9.0.0"),
      "2.1.0": manifest(">=9.0.0"),
      "2.0.0": manifest(">=9.0.0"),
    });
    const marked = await markVersionCompatibility(
      TIMER,
      versions,
      createVersionCompatibility(read, "0.79.0"),
    );

    expect(noneRunnableReason(marked)).toBe("too-new");
  });
});

describe("buildImportUpgrades — compatibility", () => {
  it("targets the newest hostable version and names the one held back", async () => {
    const { read } = reader({
      "2.2.0": manifest(">=9.0.0"),
      "2.1.0": manifest(">=0.1.0"),
    });
    const set = await buildImportUpgrades(importsText, {
      listVersions: listTimer,
      isCompatible: createVersionCompatibility(read, "0.79.0"),
    });

    expect(set?.upgrades).toHaveLength(1);
    expect(set?.upgrades[0]).toMatchObject({
      alias: "Timer",
      currentVersion: "2.0.0",
      latestVersion: "2.1.0",
      heldBack: { version: "2.2.0", reason: "too-new" },
    });
    expect(set?.upgrades[0].newSource).toBe(`${TIMER}@2.1.0`);
  });

  it("offers no upgrade when nothing newer can run, and says so", async () => {
    const { read } = reader({
      "2.2.0": manifest(">=9.0.0"),
      "2.1.0": manifest(">=9.0.0"),
    });
    const set = await buildImportUpgrades(importsText, {
      listVersions: listTimer,
      isCompatible: createVersionCompatibility(read, "0.79.0"),
    });

    expect(set?.upgrades).toHaveLength(0);
    expect(set?.skipped).toHaveLength(1);
    expect(set?.skipped[0]).toMatchObject({
      alias: "Timer",
      currentVersion: "2.0.0",
      latestVersion: "2.2.0",
      code: "incompatible",
    });
    expect(set?.skipped[0].reason).toBe("too-new");
    expect(set?.skipped[0].message).toContain("none runs on telo");
    expect(set?.skipped[0].message).toContain("Update telo to upgrade it.");
  });

  it("does not tell the author to update telo when the requirement is the unreadable one", async () => {
    const malformed = ["kind: Telo.Library", "metadata:", "  name: timer", "requires:", "  telo: 7", ""].join("\n");
    const { read } = reader({ "2.2.0": malformed, "2.1.0": malformed });
    const set = await buildImportUpgrades(importsText, {
      listVersions: listTimer,
      isCompatible: createVersionCompatibility(read, "0.79.0"),
    });

    expect(set?.skipped[0].code).toBe("incompatible");
    // Updating telo cannot fix a requirement the module failed to state.
    // The cause travels as data too, so a host phrases its own affordance
    // without re-deriving one — and cannot offer "update telo" here.
    expect(set?.skipped[0].reason).toBe("unreadable");
    expect(set?.skipped[0].message).toContain("Only the module's author can fix that.");
    expect(set?.skipped[0].message).not.toContain("Update telo");
  });

  it("upgrades to the newest version when the host cannot check at all", async () => {
    const set = await buildImportUpgrades(importsText, {
      listVersions: listTimer,
      isCompatible: uncheckedVersionCompatibility,
    });

    expect(set?.upgrades[0]).toMatchObject({ latestVersion: "2.2.0" });
    expect(set?.upgrades[0].heldBack).toBeUndefined();
  });
});

/** Geocode's published history: 1.2.1 restricts 1.2.0 and itself, 1.3.1 lifts. */
const GEOCODE = "oci://ghcr.io/acme/geocode";
const geocodeVersions: ModuleVersion[] = ["1.3.1", "1.3.0", "1.2.1", "1.2.0", "1.1.0"].map((version) => ({ version }));

function geocode(version: string, telo: string, restrictions: string[] = []): string {
  return [
    "kind: Telo.Library",
    "metadata:",
    "  name: Geocode",
    `  version: ${version}`,
    "requires:",
    `  telo: "${telo}"`,
    ...(restrictions.length > 0 ? ["restrictions:", ...restrictions] : []),
    "",
  ].join("\n");
}

const geocodeHistory: Record<string, string> = {
  "1.1.0": geocode("1.1.0", ">=0.121.0"),
  "1.2.0": geocode("1.2.0", ">=0.121.0"),
  "1.2.1": geocode("1.2.1", ">=0.121.0", [
    '  - versions: ">=1.2.0"',
    '    requires: { telo: "<0.122.0" }',
    "    reason: Lookup never returns on telo 0.122.0 and later.",
  ]),
  "1.3.0": geocode("1.3.0", ">=0.123.0"),
  "1.3.1": geocode("1.3.1", ">=0.123.0", [
    '  - versions: ">=1.2.0 <=1.2.1"',
    '    requires: { telo: ">=0.121.0" }',
    "    reason: Lookup works on every telo again since telo 0.122.1.",
  ]),
};
const published = geocodeVersions.map((v) => v.version);
/** Before 1.3.1 lifts anything. */
const beforeLift = geocodeVersions.filter((v) => v.version !== "1.3.1");
const publishedBeforeLift = beforeLift.map((v) => v.version);

describe("restrictions held by a newer version", () => {
  it("holds 1.2.0 and 1.2.1 back on telo 0.122.0 and says which entry did", async () => {
    const { read } = reader(geocodeHistory);
    const isCompatible = createVersionCompatibility(read, "0.122.0");

    expect(await isCompatible(GEOCODE, "1.2.0", publishedBeforeLift)).toMatchObject({
      compatibility: "too-old",
      bound: "<0.122.0",
      source: { from: "restriction", version: "1.2.1" },
    });
    expect(await isCompatible(GEOCODE, "1.2.1", publishedBeforeLift)).toMatchObject({
      compatibility: "too-old",
      source: { from: "restriction", version: "1.2.1" },
    });
    // The pin's own bytes carry no restriction: without the newer versions it is fine.
    expect(await isCompatible(GEOCODE, "1.2.0")).toMatchObject({ compatibility: "yes" });
  });

  it("offers no upgrade lens past 1.1.0 on telo 0.122.0", async () => {
    const { read } = reader(geocodeHistory);
    const selection = await selectCompatibleVersion(
      GEOCODE,
      beforeLift,
      "1.1.0",
      createVersionCompatibility(read, "0.122.0"),
    );
    expect(selection.best).toBeNull();
    expect(selection.heldBack).toMatchObject({ version: "1.3.0", reason: "too-new" });
  });

  it("marks 1.2.0 selectable once 1.3.1 lifts the telo key on 0.122.1, and 1.2.1 still held by its own entry", async () => {
    const { read } = reader(geocodeHistory);
    const marked = await markVersionCompatibility(
      GEOCODE,
      geocodeVersions,
      createVersionCompatibility(read, "0.122.1"),
    );
    expect(marked.map((m) => [m.version, m.compatibility])).toEqual([
      ["1.3.1", "too-new"],
      ["1.3.0", "too-new"],
      ["1.2.1", "too-old"],
      ["1.2.0", "yes"],
      ["1.1.0", "yes"],
    ]);
    expect(marked.find((m) => m.version === "1.2.1")?.detail).toContain(
      "Lookup never returns on telo 0.122.0 and later.",
    );
  });

  it("marks 1.2.0 held back by 1.2.1's entry on 0.122.0 and reads each version once", async () => {
    const { asked, read } = reader(geocodeHistory);
    const isCompatible = createVersionCompatibility(read, "0.122.0");
    const marked = await markVersionCompatibility(GEOCODE, beforeLift, isCompatible);

    expect(marked.find((m) => m.version === "1.2.0")).toMatchObject({
      compatibility: "too-old",
      detail: expect.stringContaining("1.2.1"),
    });
    await markVersionCompatibility(GEOCODE, beforeLift, isCompatible);
    expect([...asked].sort()).toEqual([...publishedBeforeLift].sort());
  });
});

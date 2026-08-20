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

    expect(await isCompatible(TIMER, "2.2.0")).toBe("too-new");
    expect(await isCompatible(TIMER, "2.1.0")).toBe("yes");
    // Declaring nothing is compatible — the bootstrap rule.
    expect(await isCompatible(TIMER, "2.0.0")).toBe("yes");
  });

  it("answers unknown for a manifest it cannot read, and never blocks", async () => {
    const isCompatible = createVersionCompatibility(async () => {
      throw new Error("offline");
    }, "0.79.0");
    expect(await isCompatible(TIMER, "2.2.0")).toBe("unknown");

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
    expect(await isCompatible(TIMER, "2.2.0")).toBe("unknown");
    expect(await isCompatible(TIMER, "2.2.0")).toBe("too-new");
    // ...and the decided verdict IS cached from then on.
    expect(await isCompatible(TIMER, "2.2.0")).toBe("too-new");
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
    expect(selection.heldBack).toEqual({ version: "2.2.0", reason: "too-new" });
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
    expect(selection.heldBack).toEqual({ version: "2.2.0", reason: "too-new" });
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
    expect(selection.heldBack).toEqual({ version: "2.2.0", reason: "unreadable" });
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
    expect(selection.heldBack).toEqual({ version: "2.2.0", reason: "too-new" });
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

import { describe, expect, it } from "vitest";
import {
  buildImportUpgrades,
  type ImportUpgradeEdit,
  type ModuleVersionLookup,
} from "../src/import-upgrades/index.js";

/** Applies a set of edits to `text` the way a host would, so a test asserts on
 *  the resulting YAML rather than on coordinates. Applied back-to-front so an
 *  earlier edit's replacement cannot shift a later edit's offsets. */
function applyEdits(text: string, edits: ImportUpgradeEdit[]): string {
  const lineOffsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineOffsets.push(i + 1);
  }
  const offset = (p: { line: number; character: number }) => lineOffsets[p.line] + p.character;

  return [...edits]
    .sort((a, b) => offset(b.range.start) - offset(a.range.start))
    .reduce(
      (acc, e) => acc.slice(0, offset(e.range.start)) + e.newText + acc.slice(offset(e.range.end)),
      text,
    );
}

const versions: ModuleVersionLookup = async (baseRef) => {
  if (baseRef === "std/console") return ["0.9.0", "1.0.0", "0.8.0"];
  if (baseRef === "oci://ghcr.io/telorun/timer") return ["2.1.0", "2.0.0"];
  throw new Error(`no such module: ${baseRef}`);
};

describe("buildImportUpgrades", () => {
  it("re-points a scalar-shorthand import to the newest release", async () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: App",
      "imports:",
      "  Console: std/console@0.9.0",
      "",
    ].join("\n");

    const set = await buildImportUpgrades(text, versions);

    expect(set?.upgrades).toHaveLength(1);
    expect(set?.upgrades[0]).toMatchObject({
      alias: "Console",
      currentVersion: "0.9.0",
      latestVersion: "1.0.0",
      newSource: "std/console@1.0.0",
      wasPinned: false,
    });
    expect(applyEdits(text, set!.upgrades[0].edits)).toContain("Console: std/console@1.0.0");
  });

  it("drops an inline integrity fragment and reports the import was pinned", async () => {
    const text = [
      "kind: Telo.Library",
      "metadata:",
      "  name: Lib",
      "imports:",
      "  Console: std/console@0.9.0#sha256-abc",
      "",
    ].join("\n");

    const set = await buildImportUpgrades(text, versions);

    expect(set?.upgrades[0]).toMatchObject({
      newSource: "std/console@1.0.0",
      wasPinned: true,
    });
    expect(applyEdits(text, set!.upgrades[0].edits)).toContain("Console: std/console@1.0.0\n");
  });

  it("deletes the object form's stale integrity line and keeps its siblings", async () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: App",
      "imports:",
      "  Timer:",
      "    source: oci://ghcr.io/telorun/timer@2.0.0",
      "    integrity: sha256-abc",
      "    variables:",
      "      tick: 5",
      "",
    ].join("\n");

    const set = await buildImportUpgrades(text, versions);
    const result = applyEdits(text, set!.upgrades[0].edits);

    expect(set?.upgrades[0]).toMatchObject({ latestVersion: "2.1.0", wasPinned: true });
    expect(result).toContain("    source: oci://ghcr.io/telorun/timer@2.1.0\n");
    expect(result).not.toContain("integrity");
    expect(result).toContain("      tick: 5");
  });

  it("skips local paths, up-to-date pins, and unparseable versions", async () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: App",
      "imports:",
      "  Local: ../sibling",
      "  Console: std/console@1.0.0",
      "  Timer: oci://ghcr.io/telorun/timer@latest",
      "",
    ].join("\n");

    const set = await buildImportUpgrades(text, versions);

    expect(set?.upgrades).toEqual([]);
    expect(set?.failures).toEqual([]);
  });

  it("never offers a prerelease as the upgrade target", async () => {
    const text = ["kind: Telo.Application", "imports:", "  P: std/pre@1.0.0", ""].join("\n");

    const set = await buildImportUpgrades(text, async () => ["1.1.0-rc.1", "1.0.0"]);

    expect(set?.upgrades).toEqual([]);
  });

  it("supersedes a prerelease pin with the newest release", async () => {
    const text = ["kind: Telo.Application", "imports:", "  P: std/pre@1.0.0-rc.1", ""].join("\n");

    const set = await buildImportUpgrades(text, async () => ["1.0.0", "1.0.0-rc.1"]);

    expect(set?.upgrades[0]).toMatchObject({ latestVersion: "1.0.0" });
  });

  it("reports a failed lookup without blanking the other imports", async () => {
    const text = [
      "kind: Telo.Application",
      "imports:",
      "  Console: std/console@0.9.0",
      "  Gone: std/missing@1.0.0",
      "",
    ].join("\n");

    const set = await buildImportUpgrades(text, versions);

    expect(set?.upgrades.map((u) => u.alias)).toEqual(["Console"]);
    expect(set?.failures).toEqual([
      { baseRef: "std/missing", message: "no such module: std/missing" },
    ]);
  });

  it("skips rather than re-points a flow-style entry whose pin cannot be spliced", async () => {
    const text = [
      "kind: Telo.Application",
      "imports:",
      "  Console: { source: std/console@0.9.0, integrity: sha256-abc }",
      "",
    ].join("\n");

    const set = await buildImportUpgrades(text, versions);

    expect(set?.upgrades).toEqual([]);
    expect(set?.skipped[0]).toMatchObject({
      alias: "Console",
      currentVersion: "0.9.0",
      latestVersion: "1.0.0",
    });
    // The anchor is what lets a host render the skip in place of the upgrade
    // affordance instead of showing nothing for an import that IS behind.
    expect(set?.skipped[0].keyRange).toBeDefined();
  });

  it("ignores an unparseable tag rather than letting it mask real candidates", async () => {
    const text = ["kind: Telo.Application", "imports:", "  C: std/console@0.9.0", ""].join("\n");

    // `latest` sorts first from the hub but cannot be ordered; the newest
    // comparable release still has to win.
    const set = await buildImportUpgrades(text, async () => ["latest", "0.9.0", "1.0.0"]);

    expect(set?.upgrades[0]).toMatchObject({ latestVersion: "1.0.0" });
  });

  it("returns undefined for a file with no module doc or no imports", async () => {
    expect(await buildImportUpgrades("kind: Run.Sequence\n", versions)).toBeUndefined();
    expect(
      await buildImportUpgrades("kind: Telo.Application\nmetadata:\n  name: App\n", versions),
    ).toBeUndefined();
  });
});

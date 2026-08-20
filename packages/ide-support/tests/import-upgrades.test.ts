import { describe, expect, it } from "vitest";
import {
  buildImportUpgrades,
  parseModuleVersions,
  type ImportUpgradeEdit,
  type ModuleVersionLookup,
  type VersionCompatibilityCheck,
} from "../src/import-upgrades/index.js";

/** A runtime that can host anything. These cases are about which version an
 *  upgrade picks and how it rewrites the YAML; compatibility filtering has its
 *  own file. */
const anyVersionRuns: VersionCompatibilityCheck = async () => "yes";

/** The builder as these tests exercise it: version lookup varies per case, the
 *  compatibility answer does not. */
function build(text: string, listVersions: ModuleVersionLookup) {
  return buildImportUpgrades(text, { listVersions, isCompatible: anyVersionRuns });
}

/** A well-formed pin: `sha256-` plus 43 base64url characters, the form
 *  `sha256Base64Url` emits. The fixtures need real ones because a pin is
 *  spliced into the author's YAML, so it is validated on the way in — a
 *  placeholder like `sha256-abc` is now (correctly) treated as no pin at all. */
function pin(seed: string): string {
  return `sha256-${seed.repeat(11).slice(0, 43)}`;
}

const NEW_PIN = pin("Ab1_");
const OLD_PIN = pin("Cd2-");
const TIMER_NEW_PIN = pin("Ef3_");
const TIMER_OLD_PIN = pin("Gh4-");

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

/** Every version carries a pin, as a hub that has ingested since the integrity
 *  column exists reports them. */
const versions: ModuleVersionLookup = async (baseRef) => {
  if (baseRef === "std/console") {
    return [
      { version: "0.9.0", integrity: OLD_PIN },
      { version: "1.0.0", integrity: NEW_PIN },
      { version: "0.8.0", integrity: pin("Ij5_") },
    ];
  }
  if (baseRef === "oci://ghcr.io/telorun/timer") {
    return [
      { version: "2.1.0", integrity: TIMER_NEW_PIN },
      { version: "2.0.0", integrity: TIMER_OLD_PIN },
    ];
  }
  throw new Error(`no such module: ${baseRef}`);
};

/** A hub that tracks the same versions but has no pin for any of them — every
 *  version ingested before the integrity column existed, or a ref nothing can
 *  hash. The pre-existing behaviour has to survive unchanged for these. */
const unpinnedVersions: ModuleVersionLookup = async (baseRef) =>
  (await versions(baseRef)).map(({ version }) => ({ version }));

describe("buildImportUpgrades", () => {
  it("re-points a scalar-shorthand import to the newest release and pins it", async () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: App",
      "imports:",
      "  Console: std/console@0.9.0",
      "",
    ].join("\n");

    const set = await build(text, versions);

    expect(set?.upgrades).toHaveLength(1);
    expect(set?.upgrades[0]).toMatchObject({
      alias: "Console",
      currentVersion: "0.9.0",
      latestVersion: "1.0.0",
      newSource: `std/console@1.0.0#${NEW_PIN}`,
      wasPinned: false,
      repinned: true,
    });
    expect(applyEdits(text, set!.upgrades[0].edits)).toContain(
      `Console: std/console@1.0.0#${NEW_PIN}`,
    );
  });

  it("replaces an inline integrity fragment with the new version's pin", async () => {
    const text = [
      "kind: Telo.Library",
      "metadata:",
      "  name: Lib",
      "imports:",
      `  Console: std/console@0.9.0#${OLD_PIN}`,
      "",
    ].join("\n");

    const set = await build(text, versions);

    expect(set?.upgrades[0]).toMatchObject({
      newSource: `std/console@1.0.0#${NEW_PIN}`,
      wasPinned: true,
      repinned: true,
    });
    expect(applyEdits(text, set!.upgrades[0].edits)).toContain(
      `Console: std/console@1.0.0#${NEW_PIN}\n`,
    );
  });

  it("re-pins the object form in place, keeping the shape the author wrote", async () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: App",
      "imports:",
      "  Timer:",
      "    source: oci://ghcr.io/telorun/timer@2.0.0",
      `    integrity: ${TIMER_OLD_PIN}`,
      "    variables:",
      "      tick: 5",
      "",
    ].join("\n");

    const set = await build(text, versions);
    const result = applyEdits(text, set!.upgrades[0].edits);

    expect(set?.upgrades[0]).toMatchObject({
      latestVersion: "2.1.0",
      repinned: true,
      // Folded, so a host previewing it sees the import as resolved rather than
      // the half of it that landed in the source scalar.
      newSource: `oci://ghcr.io/telorun/timer@2.1.0#${TIMER_NEW_PIN}`,
    });
    expect(result).toContain("    source: oci://ghcr.io/telorun/timer@2.1.0\n");
    expect(result).toContain(`    integrity: ${TIMER_NEW_PIN}\n`);
    expect(result).toContain("      tick: 5");
  });

  it("re-pins a flow-style entry that previously had to be skipped", async () => {
    const text = [
      "kind: Telo.Application",
      "imports:",
      `  Console: { source: std/console@0.9.0, integrity: ${OLD_PIN} }`,
      "",
    ].join("\n");

    const set = await build(text, versions);

    expect(set?.skipped).toEqual([]);
    expect(applyEdits(text, set!.upgrades[0].edits)).toContain(
      `{ source: std/console@1.0.0, integrity: ${NEW_PIN} }`,
    );
  });

  it("pins an import that is already at the newest version", async () => {
    const text = [
      "kind: Telo.Application",
      "imports:",
      "  Console: std/console@1.0.0",
      "",
    ].join("\n");

    const set = await build(text, versions);

    expect(set?.upgrades).toEqual([]);
    expect(set?.pins).toHaveLength(1);
    expect(set?.pins[0]).toMatchObject({
      alias: "Console",
      version: "1.0.0",
      newSource: `std/console@1.0.0#${NEW_PIN}`,
    });
    expect(applyEdits(text, set!.pins[0].edits)).toContain(
      `Console: std/console@1.0.0#${NEW_PIN}`,
    );
  });

  it("leaves an already-pinned, up-to-date import alone", async () => {
    const text = [
      "kind: Telo.Application",
      "imports:",
      `  Console: std/console@1.0.0#${NEW_PIN}`,
      "  Timer:",
      "    source: oci://ghcr.io/telorun/timer@2.1.0",
      `    integrity: ${TIMER_NEW_PIN}`,
      "",
    ].join("\n");

    const set = await build(text, versions);

    expect(set?.upgrades).toEqual([]);
    expect(set?.pins).toEqual([]);
  });

  it("never pins a moving tag, whose bytes are expected to change", async () => {
    const text = [
      "kind: Telo.Application",
      "imports:",
      "  Timer: oci://ghcr.io/telorun/timer@latest",
      "",
    ].join("\n");

    const set = await build(text, async () => [
      { version: "latest", integrity: pin("Zz9_") },
      { version: "2.1.0", integrity: TIMER_NEW_PIN },
    ]);

    expect(set?.pins).toEqual([]);
  });

  it("never writes a pin that is not a canonical hash", async () => {
    const text = [
      "kind: Telo.Application",
      "imports:",
      "  Console: std/console@0.9.0",
      "  Current: std/console@1.0.0",
      "",
    ].join("\n");

    // A hostile or buggy hub. Anything spliced into the source scalar verbatim
    // would corrupt the manifest, which no install-time verification can catch.
    const set = await build(text, async () => [
      { version: "1.0.0", integrity: 'sha256-x"\n  Evil: ../pwned' },
      { version: "0.9.0", integrity: "sha256-short" },
    ]);

    expect(set?.upgrades[0]).toMatchObject({
      newSource: "std/console@1.0.0",
      repinned: false,
    });
    expect(applyEdits(text, set!.upgrades[0].edits)).not.toContain("Evil");
    expect(set?.pins).toEqual([]);
  });

  it("skips local paths and unparseable versions", async () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: App",
      "imports:",
      "  Local: ../sibling",
      "  Timer: oci://ghcr.io/telorun/timer@latest",
      "",
    ].join("\n");

    const set = await build(text, versions);

    expect(set?.upgrades).toEqual([]);
    expect(set?.pins).toEqual([]);
    expect(set?.failures).toEqual([]);
  });

  it("never offers a prerelease as the upgrade target", async () => {
    const text = ["kind: Telo.Application", "imports:", "  P: std/pre@1.0.0", ""].join("\n");

    const set = await build(text, async () => [
      { version: "1.1.0-rc.1" },
      { version: "1.0.0" },
    ]);

    expect(set?.upgrades).toEqual([]);
  });

  it("supersedes a prerelease pin with the newest release", async () => {
    const text = ["kind: Telo.Application", "imports:", "  P: std/pre@1.0.0-rc.1", ""].join("\n");

    const set = await build(text, async () => [
      { version: "1.0.0" },
      { version: "1.0.0-rc.1" },
    ]);

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

    const set = await build(text, versions);

    expect(set?.upgrades.map((u) => u.alias)).toEqual(["Console"]);
    expect(set?.failures).toEqual([
      { baseRef: "std/missing", message: "no such module: std/missing" },
    ]);
  });

  it("ignores an unparseable tag rather than letting it mask real candidates", async () => {
    const text = ["kind: Telo.Application", "imports:", "  C: std/console@0.9.0", ""].join("\n");

    // `latest` sorts first from the hub but cannot be ordered; the newest
    // comparable release still has to win.
    const set = await build(text, async () => [
      { version: "latest" },
      { version: "0.9.0" },
      { version: "1.0.0" },
    ]);

    expect(set?.upgrades[0]).toMatchObject({ latestVersion: "1.0.0" });
  });

  it("returns undefined for a file with no module doc or no imports", async () => {
    expect(await build("kind: Run.Sequence\n", versions)).toBeUndefined();
    expect(
      await build("kind: Telo.Application\nmetadata:\n  name: App\n", versions),
    ).toBeUndefined();
  });

  describe("when the hub publishes no pin", () => {
    it("upgrades without pinning, and offers nothing to pin", async () => {
      const text = [
        "kind: Telo.Application",
        "imports:",
        "  Console: std/console@0.9.0",
        "  Current: std/console@1.0.0",
        "",
      ].join("\n");

      const set = await build(text, unpinnedVersions);

      expect(set?.upgrades[0]).toMatchObject({
        newSource: "std/console@1.0.0",
        wasPinned: false,
        repinned: false,
      });
      expect(set?.pins).toEqual([]);
    });

    it("drops a stale fragment rather than carrying it to a new version", async () => {
      const text = [
        "kind: Telo.Application",
        "imports:",
        `  Console: std/console@0.9.0#${OLD_PIN}`,
        "",
      ].join("\n");

      const set = await build(text, unpinnedVersions);

      expect(set?.upgrades[0]).toMatchObject({ wasPinned: true, repinned: false });
      expect(applyEdits(text, set!.upgrades[0].edits)).toContain(
        "Console: std/console@1.0.0\n",
      );
    });

    it("deletes a stale object-form integrity line and keeps its siblings", async () => {
      const text = [
        "kind: Telo.Application",
        "imports:",
        "  Timer:",
        "    source: oci://ghcr.io/telorun/timer@2.0.0",
        `    integrity: ${TIMER_OLD_PIN}`,
        "    variables:",
        "      tick: 5",
        "",
      ].join("\n");

      const set = await build(text, unpinnedVersions);
      const result = applyEdits(text, set!.upgrades[0].edits);

      expect(set?.upgrades[0]).toMatchObject({ wasPinned: true, repinned: false });
      expect(result).toContain("    source: oci://ghcr.io/telorun/timer@2.1.0\n");
      expect(result).not.toContain("integrity");
      expect(result).toContain("      tick: 5");
    });

    it("declines a flow-style entry whose stale pin cannot be spliced out", async () => {
      const text = [
        "kind: Telo.Application",
        "imports:",
        `  Console: { source: std/console@0.9.0, integrity: ${OLD_PIN} }`,
        "",
      ].join("\n");

      const set = await build(text, unpinnedVersions);

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
  });
});

describe("parseModuleVersions", () => {
  it("reads the route's entries and preserves its ordering", () => {
    expect(
      parseModuleVersions({
        ref: "oci://ghcr.io/telorun/timer",
        versions: [{ version: "2.1.0", integrity: TIMER_NEW_PIN }, { version: "2.0.0" }],
      }),
    ).toEqual([{ version: "2.1.0", integrity: TIMER_NEW_PIN }, { version: "2.0.0" }]);
  });

  it("drops an integrity that is not a canonical hash, keeping the version", () => {
    expect(
      parseModuleVersions({ versions: [{ version: "1.0.0", integrity: "sha256-nope" }] }),
    ).toEqual([{ version: "1.0.0" }]);
  });

  it("tolerates every shape a hub could answer with", () => {
    expect(parseModuleVersions(undefined)).toEqual([]);
    expect(parseModuleVersions({})).toEqual([]);
    expect(parseModuleVersions({ versions: "1.0.0" })).toEqual([]);
    // Bare strings: what the route returned before it carried pins. Dropped
    // rather than coerced — a version list from a hub that old carries no pin
    // to write, and guessing at the shape is what hid the last drift.
    expect(parseModuleVersions({ versions: ["1.0.0", { version: "" }, null] })).toEqual([]);
  });
});

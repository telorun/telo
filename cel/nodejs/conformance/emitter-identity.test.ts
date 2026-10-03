/**
 * Runs every conformance row through both backends and holds their answers to each other.
 *
 * The vectors directory is a parameter (`CEL_CONFORMANCE_DIR`) with no default, as in the
 * two replays beside it: this package's own suite must pass with no vectors reachable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replayEmitterIdentity } from "./emitter-identity.js";
import { DRIVEN_FILE, type LanguageRow } from "./language-replay.js";

const directory = process.env.CEL_CONFORMANCE_DIR;
if (!directory) {
  throw new Error(
    "CEL_CONFORMANCE_DIR must name the directory holding the CEL conformance vectors; this config runs nothing without it",
  );
}

const file = JSON.parse(readFileSync(join(directory, DRIVEN_FILE), "utf8")) as {
  readonly rows: readonly LanguageRow[];
};
const report = await replayEmitterIdentity(file.rows);

describe("CEL conformance — the emitter answers every row as the closure backend does", () => {
  it("answers every row it compares identically, value for value", () => {
    expect(report.differences).toEqual([]);
  });

  it("accounts for every row of the file: compared, unreadable, or refused by both", () => {
    expect(
      report.compared + report.unreadable + report.refusedAtCompile + report.bindingsUnreadable.length,
    ).toBe(report.rows);
  });

  it("actually compares the bulk of the file, so a driver that compares nothing fails", () => {
    // The counting guard. A grouping bug that emptied every group would leave the
    // difference list empty too, which is the one way this gate could pass by doing nothing.
    expect(report.compared).toBeGreaterThan(1500);
  });

  it("emits the rows as a handful of modules rather than one per row", () => {
    // Rows share an environment unless they declare a function, and the key is over the
    // environment's digest — so this is also a check that the digest does not fragment.
    expect(report.modules).toBeGreaterThan(0);
    expect(report.modules).toBeLessThan(report.compared / 10);
    console.log(
      [
        `rows ${report.rows}: ${report.compared} compared on both backends,`,
        `${report.refusedAtCompile} refused by both at compile,`,
        `${report.unreadable} not read whole,`,
        `${report.bindingsUnreadable.length} whose recorded bindings the encoding cannot read,`,
        `${report.differences.length} disagreements.`,
        `Emitted as ${report.modules} module${report.modules === 1 ? "" : "s"}.`,
      ].join("\n"),
    );
  });
});

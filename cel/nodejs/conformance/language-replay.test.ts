/**
 * Runs the conformance language rows, whole.
 *
 * The vectors directory is a **parameter** — `CEL_CONFORMANCE_DIR`, with no default
 * — because this package's own suite must pass with no vectors reachable at all, and
 * because where the vectors live is not this package's to know. The caller that
 * knows is the repository gate that invokes this config.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DRIVEN_FILE, LANGUAGE_ROWS, type LanguageRow, replayLanguageRows } from "./language-replay.js";

/** Files of the vectors this driver deliberately leaves alone, and why. */
const NOT_DRIVEN: Record<string, string> = {
  "README.md": "the format's own documentation",
  "catalog.json": "the function catalog, driven by `dialect-replay.test.ts`",
  "types.json": "a host's own types, driven by `dialect-replay.test.ts`",
  "holes.json": "the `${{ … }}` hole grammar, which is a tag's reading of a scalar and not CEL",
  "module-calls.json": "a tag engine's resolution and dispatch, through its own seams",
  "verdicts.json": "a tag engine's diagnostic and error vocabulary",
};

const directory = process.env.CEL_CONFORMANCE_DIR;
if (!directory) {
  throw new Error(
    "CEL_CONFORMANCE_DIR must name the directory holding the CEL conformance vectors; this config runs nothing without it",
  );
}

interface LanguageFile {
  readonly celSpec: { readonly commit: string };
  readonly rows: readonly LanguageRow[];
}

const file = JSON.parse(readFileSync(join(directory, DRIVEN_FILE), "utf8")) as LanguageFile;
const report = replayLanguageRows(file.rows);

describe("CEL conformance — language rows, whole", () => {
  it("knows every file in the vectors directory", () => {
    const known = [DRIVEN_FILE, ...Object.keys(NOT_DRIVEN)].sort();
    expect(readdirSync(directory).sort()).toEqual(known);
  });

  it("reads a well-formed language file", () => {
    expect(Object.keys(file).sort()).toEqual(["celSpec", "rows"]);
    expect(Object.keys(file.celSpec)).toEqual(["commit"]);
    expect(file.celSpec.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("holds every row to the format", () => {
    expect(report.malformed).toEqual([]);
  });

  it("executes every row of the file, and the file holds the pinned number of rows", () => {
    expect(report.rows).toBe(LANGUAGE_ROWS);
    expect(report.driven).toBe(report.rows);
  });

  it("records the engine's whole answer on every row", () => {
    expect(report.answers).toEqual([]);
  });

  it("states a deviation only where the answer differs from cel-spec, with one of the four reasons", () => {
    expect(report.deviations).toEqual([]);
  });

  it("records only the engine's own codes as an error's celCode", () => {
    expect(report.celCodes).toEqual([]);
  });

  it("writes back and re-reads every source that reads to an equal tree", () => {
    expect(report.roundTrip).toEqual([]);
    expect(report.roundTripped + report.unreadable).toBe(report.driven);
    console.log(
      `rows ${report.rows}: ${report.driven} answered whole, ${report.roundTripped} written back equal, ${report.unreadable} not read whole.`,
    );
  });
});

/**
 * Runs the conformance language rows against the front end.
 *
 * The vectors directory is a **parameter** — `CEL_CONFORMANCE_DIR`, with no default
 * — because this package's own suite must pass with no vectors reachable at all, and
 * because where the vectors live is not this package's to know. The caller that
 * knows is the repository gate that invokes this config.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DRIVEN_FILE, type LanguageRow, replayLanguageRows, SPEC_CORRECTIONS } from "./language-replay.js";

/**
 * Files of the vectors this driver deliberately leaves alone, and why. The two dialect
 * files it used to leave to "whoever registers a catalog" are now driven beside it
 * (`dialect-replay.test.ts`): the engine carries the catalog, and a host's types reach it
 * through `registerType`.
 */
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

describe("CEL conformance — language rows through the front end", () => {
  it("knows every file in the vectors directory", () => {
    const known = [DRIVEN_FILE, ...Object.keys(NOT_DRIVEN)].sort();
    expect(readdirSync(directory).sort()).toEqual(known);
  });

  it("reads a well-formed language file", () => {
    expect(Object.keys(file).sort()).toEqual(["celSpec", "rows"]);
    expect(file.celSpec.commit).toMatch(/^[0-9a-f]{40}$/);
    const ids = new Set<string>();
    for (const row of file.rows) {
      expect(typeof row.source, row.id).toBe("string");
      expect(row, `row ${row.id} has no expect`).toHaveProperty("expect");
      expect(ids.has(row.id), `row id ${row.id} repeats`).toBe(false);
      ids.add(row.id);
    }
  });

  it("drives every row of the file", () => {
    expect(report.driven).toBe(file.rows.length);
  });

  it("answers every row it drives", () => {
    expect(report.failures).toEqual([]);
  });

  it("accounts for every row: checked, refused where it refuses, corrected, or excluded", () => {
    expect(
      report.checkedToRecordedType +
        report.refusedAtRecordedOffset +
        report.refusedWithNoRecordedOffset +
        report.correctionsSeen.length +
        report.exclusionsSeen.length,
    ).toBe(report.rows);
  });

  it("leaves no row that needs a position without one", () => {
    expect(report.unaccounted).toEqual([]);
  });

  it("holds every exclusion group to its pinned row count", () => {
    expect(report.exclusionCounts.filter((group) => group.rows !== group.pinned)).toEqual([]);
  });

  it("puts no row on both lists", () => {
    const corrected = new Set(report.correctionsSeen);
    expect(report.exclusionsSeen.filter((row) => corrected.has(row))).toEqual([]);
  });

  it("lists exactly the rows it corrects, each with its authority", () => {
    expect([...report.correctionsSeen].sort()).toEqual([...SPEC_CORRECTIONS.keys()].sort());
    for (const [row, authority] of SPEC_CORRECTIONS) expect(authority.length, row).toBeGreaterThan(40);
  });

  it("declares every expectation answered elsewhere or not comparable, each naming rows that exist", () => {
    expect(report.answeredElsewhere.length).toBeGreaterThan(0);
    for (const held of [...report.answeredElsewhere, ...report.incomparable]) {
      expect(held.rows, held.expectation).toBeGreaterThan(0);
    }
    console.log(
      [
        `rows ${report.rows}: ${report.roundTripped} written back equal,`,
        `${report.checkedToRecordedType} checked to the recorded type,`,
        `${report.refusedAtRecordedOffset} refused at the recorded offset,`,
        `${report.correctionsSeen.length} corrected against cel-spec,`,
        `${report.exclusionsSeen.length} excluded with a reason,`,
        `${report.refusedWithNoRecordedOffset} refused where no offset is recorded.`,
        `Vectors record ${report.recordedChecking} checking and ${report.recordedRefused} refused.`,
        "Answered by the value-level replay beside this one:",
        ...report.answeredElsewhere.map(
          (d) => `  ${d.expectation} — ${d.rows} rows → ${d.answeredBy} (${d.because})`,
        ),
        `Exclusions: ${report.exclusionCounts.map((g) => `${g.reason} ${g.rows}`).join(", ")}.`,
        "Not comparable:",
        ...report.incomparable.map(
          (d) => `  ${d.expectation} — ${d.rows} rows (${d.because}); compared instead: ${d.insteadCompared}`,
        ),
        `Not driven: ${Object.entries(NOT_DRIVEN)
          .map(([name, why]) => `${name} (${why})`)
          .join("; ")}`,
      ].join("\n"),
    );
  });
});

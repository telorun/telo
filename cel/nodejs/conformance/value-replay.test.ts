/**
 * Runs the conformance language rows at the value level — what each row evaluates to.
 *
 * The vectors directory is a parameter (`CEL_CONFORMANCE_DIR`) with no default, as in the
 * check-level replay: this package's own suite must pass with no vectors reachable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DRIVEN_FILE, type LanguageRow } from "./language-replay.js";
import {
  RECORDED_MESSAGE_ROWS,
  replayLanguageValues,
  VALUE_CORRECTIONS,
  VALUE_EXCLUSION_GROUPS,
  VALUE_PENDING_DECISIONS,
} from "./value-replay.js";

const directory = process.env.CEL_CONFORMANCE_DIR;
if (!directory) {
  throw new Error(
    "CEL_CONFORMANCE_DIR must name the directory holding the CEL conformance vectors; this config runs nothing without it",
  );
}

const file = JSON.parse(readFileSync(join(directory, DRIVEN_FILE), "utf8")) as {
  readonly rows: readonly LanguageRow[];
};
const report = replayLanguageValues(file.rows);

describe("CEL conformance — language rows at the value level", () => {
  it("drives every row of the file", () => {
    expect(report.driven).toBe(file.rows.length);
  });

  it("answers every row it drives", () => {
    expect(report.failures).toEqual([]);
  });

  it("accounts for every row: matched, corrected, excluded, answered by the check seam, or pinned", () => {
    expect(
      report.matched +
        report.correctionsSeen.length +
        report.exclusionsSeen.length +
        report.checkSeamRows.length +
        report.pendingSeen.length,
    ).toBe(report.rows);
  });

  it("leaves no row unaccounted for", () => {
    expect(report.unaccounted).toEqual([]);
  });

  it("holds every correction and exclusion group to its pinned row count", () => {
    expect(report.correctionCounts.filter((group) => group.rows !== group.pinned)).toEqual([]);
    expect(report.exclusionCounts.filter((group) => group.rows !== group.pinned)).toEqual([]);
  });

  it("lists exactly the rows it corrects, each with its authority", () => {
    expect([...report.correctionsSeen].sort()).toEqual([...VALUE_CORRECTIONS.keys()].sort());
    for (const [row, authority] of VALUE_CORRECTIONS) expect(authority.length, row).toBeGreaterThan(40);
  });

  it("gives every exclusion group a reason, and covers a row by a fact rather than by nothing", () => {
    for (const group of VALUE_EXCLUSION_GROUPS) {
      expect(group.because.length, group.reason).toBeGreaterThan(40);
      // A group covers rows by one of three facts, never by an empty declaration: the ids it
      // names, the check-level list for the same reason, or an uncarried input of the row.
      expect(
        group.ids.length > 0 || group.alsoAtCheckLevel || (group.uncarriedInputs ?? []).length > 0,
        group.reason,
      ).toBe(true);
      expect(group.rows, group.reason).toBeGreaterThan(0);
    }
  });

  it("hands every type-only cel-spec answer to the check-level driver, which accounts for it", () => {
    // Asserted there, not assumed here: the ids are on that driver's own correction or
    // exclusion lists, which is what `answeredByTheCheckSeam` requires before it defers.
    expect(report.checkSeamRows.length).toBeGreaterThan(0);
  });

  it("states every pending decision in full, and pins each of its rows", () => {
    expect([...report.pendingSeen].sort()).toEqual(
      VALUE_PENDING_DECISIONS.flatMap((pending) => pending.answers.map((row) => row.id)).sort(),
    );
    for (const pending of VALUE_PENDING_DECISIONS) {
      expect(pending.question.length).toBeGreaterThan(200);
      expect(pending.answers.length).toBeGreaterThan(0);
    }
  });

  it("reproduces, byte for byte, the recorded error text of the rows the format owns", () => {
    expect([...report.messagesMatched].sort()).toEqual([...RECORDED_MESSAGE_ROWS].sort());
  });

  it("declares what it does not compare, and reports what it did", () => {
    for (const held of report.notCompared) expect(held.rows, held.expectation).toBeGreaterThan(0);
    console.log(
      [
        `rows ${report.rows}: ${report.matched} answered as recorded,`,
        `${report.correctionsSeen.length} corrected against cel-spec,`,
        `${report.exclusionsSeen.length} excluded with a reason,`,
        `${report.pendingSeen.length} pinned awaiting a decision,`,
        `${report.checkSeamRows.length} answered by the check-level driver (a type, not a value),`,
        `${report.messagesMatched.length} error texts reproduced byte for byte,`,
        `${report.unaccounted.length} unaccounted.`,
        `Vectors record ${report.recordedValue} values and ${report.recordedError} errors.`,
        `Corrections: ${report.correctionCounts.map((group) => `${group.cause} ${group.rows}`).join("; ")}.`,
        `Exclusions: ${report.exclusionCounts.map((group) => `${group.reason} ${group.rows}`).join("; ") || "none"}.`,
        "Not compared:",
        ...report.notCompared.map((held) => `  ${held.expectation} — ${held.rows} rows (${held.because})`),
      ].join("\n"),
    );
  });
});

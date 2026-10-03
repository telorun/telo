/**
 * Runs the conformance vectors' dialect files — the function catalog and the host's types —
 * against the engine with the catalog registered.
 *
 * The vectors directory is a **parameter** (`CEL_CONFORMANCE_DIR`) and so is the host's
 * type vocabulary (`CEL_CONFORMANCE_HOST_TYPES`, a JSON list of nominal type definitions):
 * this package's own suite must pass with no vectors reachable at all, and the names of a
 * host's types are not this package's to know. The caller that knows both is the
 * repository gate that invokes this config.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NominalTypeDefinition } from "../src/index.js";
import { CATALOG_CORRECTIONS, CATALOG_EXCLUSIONS, CATALOG_FILE } from "./catalog-replay.js";
import {
  replayDialectRows,
  unknownDeclaredTypes,
  type DialectReplayReport,
  type DialectRow,
} from "./dialect-replay.js";
import { TYPES_CORRECTIONS, TYPES_EXCLUSIONS, TYPES_FILE } from "./types-replay.js";

const directory = process.env.CEL_CONFORMANCE_DIR;
if (!directory) {
  throw new Error(
    "CEL_CONFORMANCE_DIR must name the directory holding the CEL conformance vectors; this config runs nothing without it",
  );
}
const declared = process.env.CEL_CONFORMANCE_HOST_TYPES;
if (!declared) {
  throw new Error(
    "CEL_CONFORMANCE_HOST_TYPES must carry the host's nominal type definitions as JSON; the dialect rows declare variables of them and this engine knows no host's type names",
  );
}
const hostTypes = JSON.parse(declared) as readonly NominalTypeDefinition[];

function rowsOf(file: string): readonly DialectRow[] {
  const held = JSON.parse(readFileSync(join(directory!, file), "utf8")) as {
    readonly rows: readonly DialectRow[];
  };
  expect(Object.keys(held), `${file} carries only its rows`).toEqual(["rows"]);
  return held.rows;
}

const files = [
  { file: CATALOG_FILE, corrections: CATALOG_CORRECTIONS, exclusions: CATALOG_EXCLUSIONS },
  { file: TYPES_FILE, corrections: TYPES_CORRECTIONS, exclusions: TYPES_EXCLUSIONS },
];

for (const held of files) {
  const rows = rowsOf(held.file);
  const report: DialectReplayReport = replayDialectRows(rows, {
    file: held.file,
    hostTypes,
    corrections: held.corrections,
    exclusions: held.exclusions,
  });

  describe(`CEL conformance — ${held.file} through the engine and its catalog`, () => {
    it("reads a well-formed dialect file", () => {
      const ids = new Set<string>();
      for (const row of rows) {
        expect(typeof row.source, row.id).toBe("string");
        expect(row, `row ${row.id} has no expect`).toHaveProperty("expect");
        expect(row.tag, `row ${row.id} names no tag`).toBeTypeOf("string");
        expect(ids.has(row.id), `row id ${row.id} repeats`).toBe(false);
        ids.add(row.id);
      }
    });

    it("is given a host type for every type its rows declare", () => {
      expect(unknownDeclaredTypes(rows, hostTypes)).toEqual([]);
    });

    it("drives every row of the file", () => {
      expect(report.driven).toBe(rows.length);
    });

    it("answers every row it drives", () => {
      expect(report.failures).toEqual([]);
    });

    it("accounts for every row: answered, corrected, or excluded", () => {
      expect(report.matched + report.correctionsSeen.length + report.exclusionsSeen.length).toBe(
        report.rows,
      );
      expect(report.unaccounted).toEqual([]);
    });

    it("holds every correction and exclusion group to its pinned row count", () => {
      expect(report.correctionCounts.filter((group) => group.rows !== group.pinned)).toEqual([]);
      expect(report.exclusionCounts.filter((group) => group.rows !== group.pinned)).toEqual([]);
      for (const group of held.corrections) expect(group.authority.length, group.cause).toBeGreaterThan(40);
    });

    it("declares what it does not answer, each naming rows that exist", () => {
      for (const elsewhere of [...report.answeredElsewhere, ...report.notCompared]) {
        expect(elsewhere.rows, elsewhere.expectation).toBeGreaterThan(0);
      }
      console.log(
        [
          `${held.file}: rows ${report.rows}, ${report.matched} answered,`,
          `${report.correctionsSeen.length} corrected against a cited authority,`,
          `${report.exclusionsSeen.length} excluded with a reason.`,
          `${report.typesCompared} checked to the recorded type,`,
          `${report.refusalsPinned.length} refusals reproduced byte for byte,`,
          `${report.guardsPinned.length} literal-guard diagnostics reproduced byte for byte.`,
          "Answered elsewhere:",
          ...report.answeredElsewhere.map(
            (d) => `  ${d.expectation} — ${d.rows} rows → ${d.answeredBy} (${d.because})`,
          ),
          "Not compared:",
          ...report.notCompared.map((d) => `  ${d.expectation} — ${d.rows} rows (${d.because})`),
        ].join("\n"),
      );
    });
  });
}

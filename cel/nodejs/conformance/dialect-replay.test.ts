/**
 * Runs the conformance vectors' dialect files the engine alone answers — the function
 * catalog and the host's types — through the projection driver.
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
import {
  CATALOG_FILE,
  CATALOG_ROWS,
  dialectEnvironment,
  inputProblems,
  replayDialectRows,
  TYPES_FILE,
  TYPES_ROWS,
  unknownDeclaredTypes,
  type DialectRow,
} from "./dialect-replay.js";

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

for (const held of [
  { file: CATALOG_FILE, rows: CATALOG_ROWS },
  { file: TYPES_FILE, rows: TYPES_ROWS },
]) {
  const rows = rowsOf(held.file);
  const report = replayDialectRows(held.file, rows, hostTypes);

  describe(`CEL conformance — ${held.file} through the engine's projection`, () => {
    it("is given a host type for every type its rows declare", () => {
      expect(unknownDeclaredTypes(rows, hostTypes)).toEqual([]);
    });

    it("reads every row as a question the engine alone answers", () => {
      expect(report.malformed).toEqual([]);
      expect(report.inputs).toEqual([]);
    });

    it("answers the projection of every row", () => {
      expect(report.answers).toEqual([]);
    });

    it("drives every row of the file, and the file holds the rows it is pinned to", () => {
      expect(report.driven).toBe(rows.length);
      expect(rows.length).toBe(held.rows);
      console.log(`${held.file}: rows ${report.rows}, ${report.driven} answered through the projection`);
    });
  });
}

describe("the input gate", () => {
  const row = (extra: Record<string, unknown>, source = "1"): DialectRow =>
    ({
      id: "scratch/input",
      tag: "cel",
      source,
      ...extra,
      expect: { check: { diagnostics: [] }, value: { $telo: "int", value: "1" } },
    }) as unknown as DialectRow;

  it("refuses a tag other than cel, a tag-site input, a source that does not read and an error that is not the engine's", () => {
    const base = dialectEnvironment();
    expect(inputProblems(base, row({ tag: "interpolate" }))).toEqual([
      'names the tag "interpolate"; these files ask the cel engine alone',
    ]);
    expect(inputProblems(base, row({ context: {} }))).toEqual([
      "carries `context`, an input only a tag site has",
    ]);
    expect(inputProblems(base, row({}, "1 +"))).toEqual([expect.stringMatching(/^does not read: /)]);
    const coded = {
      ...row({}),
      expect: { check: { diagnostics: [] }, error: { code: "ERR_X", celCode: null, message: "x" } },
    } as unknown as DialectRow;
    expect(inputProblems(base, coded)).toEqual([
      'records an error that is not the engine\'s own: {"code":"ERR_X","celCode":null,"message":"x"}',
    ]);
    expect(inputProblems(base, row({}))).toEqual([]);
  });
});

/**
 * The schema-validation conformance vectors, as the analyzer answers them: every row
 * of an `analysis*` configuration, through the configuration factory, the opaque view
 * and — for `analysis-defaults` — the value-type default filler, exactly as
 * `validateAgainstSchema` / `validateAgainstSchemaWithDefaults` run them. A row's
 * `issues` are the judge's (`judgedSchemaIssues`). The kernel configurations are
 * `kernel/nodejs/tests/schema-validation-conformance.test.ts`'s.
 *
 * Blind spot: deep equality pins whatever this runtime answered when the row was
 * recorded; a row is a check against the JSON Schema test suite only where it
 * carries `deviation.suite`, and against nothing else.
 */
import { finishedIssues } from "./judged-validation.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeTypedFrame,
  encodeTypedFrame,
  isOpaqueSchemaValue,
  opaqueSchemaView,
  schemaHeldValue,
} from "@telorun/sdk";
import {
  createAjv,
  judgedSchemaIssues,
  SCHEMA_VALIDATION_CONFIGURATIONS,
  type SchemaValidationConfiguration,
} from "../src/schema-validation.js";
import { valueTypeDefaultFiller } from "../src/value-type-defaults.js";
import type { StandIns } from "../src/stand-in-findings.js";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../schema-validation-conformance/vectors");

/** Every file's row count, and how many of them this runner answers. */
const FILES: Record<string, { rows: number; analysis: number }> = {
  "draft7.json": { rows: 1840, analysis: 1840 },
  "telo.json": { rows: 195, analysis: 141 },
  "unions.json": { rows: 31, analysis: 31 },
};

interface Row {
  id: string;
  description?: string;
  configuration: SchemaValidationConfiguration;
  schema: unknown;
  documents: { id: string; schema: unknown }[];
  value: unknown;
  standIns?: Record<string, unknown>;
  expect: { valid: boolean | null; errors: unknown[] | null; value: unknown; compileError: string | null; issues: unknown[] | null };
  deviation?: { suite: { valid: boolean } };
}

const ROW_KEYS = new Set(["id", "description", "configuration", "schema", "documents", "value", "standIns", "expect", "deviation"]);
const EXPECT_KEYS = ["valid", "errors", "value", "compileError", "issues"];

/** A row's value: plain containers as JSON reads them, a `$telo` object a typed frame. */
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if ("$telo" in value) return decodeTypedFrame(JSON.stringify(value));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}

function encode(value: unknown): unknown {
  if (isOpaqueSchemaValue(value)) return encode(schemaHeldValue(value));
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  }
  return JSON.parse(encodeTypedFrame(value));
}

const quiet = { log() {}, warn() {}, error: console.error };

function answer(row: Row): Row["expect"] {
  const ajv = createAjv(row.configuration);
  (ajv as unknown as { logger: unknown }).logger = quiet;
  for (const document of row.documents) ajv.addSchema(document.schema as object, document.id);
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(row.schema as object);
  } catch (error) {
    return { valid: null, errors: null, value: null, compileError: (error as Error).message, issues: null };
  }
  const data = decode(row.value);
  if (row.configuration === "analysis-defaults") valueTypeDefaultFiller(row.schema as Record<string, any>)?.(data);
  const view = opaqueSchemaView(data);
  const valid = validate(view) as boolean;
  const errors = (validate.errors ?? []).map((error) => ({
    keyword: error.keyword,
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    params: error.params,
    message: error.message ?? null,
  }));
  const issues =
    row.standIns === undefined
      ? null
      : valid
        ? []
        : finishedIssues(
            judgedSchemaIssues(ajv, validate.errors, data, row.schema as object, new Map(Object.entries(row.standIns)) as StandIns),
          ).map((issue) => ({ path: issue.path, message: issue.message }));
  return { valid, errors, value: encode(view), compileError: null, issues };
}

for (const [file, counts] of Object.entries(FILES)) {
  const rows = (JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")) as { rows: Row[] }).rows;
  const mine = rows.filter((row) => row.configuration.startsWith("analysis"));

  describe(`schema-validation conformance: ${file}`, () => {
    it("holds its pinned rows, each well formed", () => {
      expect(rows.length).toBe(counts.rows);
      expect(mine.length).toBe(counts.analysis);
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      for (const row of rows) {
        expect(Object.keys(row).filter((key) => !ROW_KEYS.has(key)), row.id).toEqual([]);
        expect(SCHEMA_VALIDATION_CONFIGURATIONS, row.id).toContain(row.configuration);
        expect(Object.keys(row.expect).sort(), row.id).toEqual([...EXPECT_KEYS].sort());
        if (row.deviation !== undefined) {
          expect(Object.keys(row.deviation), row.id).toEqual(["suite"]);
          expect(row.deviation.suite.valid, `${row.id}: a deviation that agrees is dropped`).not.toBe(row.expect.valid);
        }
      }
    });

    for (const row of mine) {
      it(row.id, () => {
        expect(answer(row)).toEqual(row.expect);
      });
    }
  });
}

/**
 * The schema-validation conformance vectors, as the kernel answers them: every row of
 * a kernel configuration (`primary`, `filling`, `locating`, `schema-validate`), on the
 * factory's instance, through the kernel's BigInt view. `primary` and `filling` fill a
 * value-type default decoded first and merge the view's fills back, as
 * `SchemaValidator.compile` does; `schema-validate` answers the view it validated, as
 * `ctx.validateSchema` holds it. The `analysis*` rows are the analyzer's runner's.
 *
 * Blind spot: deep equality pins whatever this runtime answered when the row was
 * recorded.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAjv, valueTypeDefaultFiller, type SchemaValidationConfiguration } from "@telorun/analyzer";
import {
  decodeTypedFrame,
  encodeTypedFrame,
  isOpaqueSchemaValue,
  schemaHeldValue,
} from "@telorun/sdk";
import { bigIntView, mergeFilledDefaults } from "../src/bigint-schema-view.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, "../../../analyzer/schema-validation-conformance/vectors");
const KERNEL_CONFIGURATIONS: ReadonlySet<string> = new Set(["primary", "filling", "locating", "schema-validate"]);

/** How many rows of each file this runner answers. */
const FILES: Record<string, number> = { "draft7.json": 0, "telo.json": 54, "unions.json": 0 };

interface Row {
  id: string;
  configuration: SchemaValidationConfiguration;
  schema: unknown;
  documents: { id: string; schema: unknown }[];
  value: unknown;
  expect: { valid: boolean | null; errors: unknown[] | null; value: unknown; compileError: string | null; issues: unknown[] | null };
}

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
  const fills = row.configuration === "primary" || row.configuration === "filling";
  if (fills) {
    valueTypeDefaultFiller(row.schema as Record<string, any>, (id) =>
      row.documents.find((document) => document.id === id)?.schema as Record<string, any> | undefined,
    )?.(data);
  }
  const { view, context } = bigIntView(data);
  const valid = validate(view, context) as boolean;
  let after: unknown = data;
  if (row.configuration === "schema-validate") after = view;
  else if (view !== data) mergeFilledDefaults(data, view);
  const errors = (validate.errors ?? []).map((error) => ({
    keyword: error.keyword,
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    params: error.params,
    message: error.message ?? null,
  }));
  return { valid, errors, value: encode(after), compileError: null, issues: null };
}

for (const [file, count] of Object.entries(FILES)) {
  const rows = (JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")) as { rows: Row[] }).rows;
  const mine = rows.filter((row) => KERNEL_CONFIGURATIONS.has(row.configuration));

  describe(`schema-validation conformance (kernel): ${file}`, () => {
    it("holds its pinned rows", () => {
      expect(mine.length).toBe(count);
    });
    for (const row of mine) {
      it(row.id, () => {
        expect(answer(row)).toEqual(row.expect);
      });
    }
  });
}

describe("every validator is the factory's", () => {
  it("builds no AJV instance in the analyzer or the kernel but through the configuration factory", () => {
    const root = path.resolve(HERE, "../../..");
    const offenders: string[] = [];
    const walk = (at: string): void => {
      for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
        const file = path.join(at, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith(".ts") && /new Ajv\b/.test(fs.readFileSync(file, "utf8"))) {
          offenders.push(path.relative(root, file).split(path.sep).join("/"));
        }
      }
    };
    walk(path.join(root, "analyzer/nodejs/src"));
    walk(path.join(root, "kernel/nodejs/src"));
    expect(offenders).toEqual(["analyzer/nodejs/src/schema-validation.ts"]);
  });
});

describe("a schema pattern is RE2 at load", () => {
  it("refuses a kind whose schema holds a lookahead", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    const refusal = await kernel.load(path.join(HERE, "__fixtures__/schema-pattern/telo.yaml")).then(
      () => undefined,
      (error: { code?: string; diagnostics?: { code?: string; message: string }[] }) => error,
    );
    expect(refusal?.code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
    expect(refusal?.diagnostics?.map(({ code, message }) => ({ code, message }))).toEqual([
      {
        code: "SCHEMA_VIOLATION",
        message: expect.stringContaining('invalid RE2 pattern "^(?!tmp$)[a-z]+$": invalid or unsupported Perl syntax'),
      },
    ]);
  });
});

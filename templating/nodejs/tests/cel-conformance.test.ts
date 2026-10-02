/**
 * The CEL conformance vectors (`templating/cel-conformance/README.md`): every row
 * of every file this runner drives is executed, and its `expect` compared whole.
 */
import { readdirSync, readFileSync } from "node:fs";
import { valueBrandBases } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { CEL_FUNCTIONS, RE2_PATTERN_ERROR_KINDS } from "../src/cel/catalog.js";
import { buildCelEnvironment, buildCelLanguageEnvironment } from "../src/cel/environment.js";
import { CEL_VERDICT_CODES } from "../src/cel/verdict-codes.js";
import {
  catalogOverloads,
  CONFORMANCE_HANDLERS,
  DIALECT_TAGS,
  dispatchTracingEnvironment,
  evaluateDialectRow,
  runDialectRow,
  type Declaration,
  type DialectRow,
} from "./cel-conformance-dialect.js";
import {
  checkLanguageRow,
  evaluateLanguageRow,
  outOfDomainType,
  runLanguageRow,
  type LanguageRow,
} from "./cel-conformance-language.js";
import { conformanceValueCodec } from "./cel-conformance-value.js";

const DIRECTORY = new URL("../../cel-conformance/", import.meta.url);
const DIALECT_FILES = ["catalog.json", "holes.json", "module-calls.json", "types.json", "verdicts.json"];
const DRIVEN = [...DIALECT_FILES, "language.json"].sort();
const ROW_KEYS = new Set([
  "id",
  "source",
  "provenance",
  "declarations",
  "functions",
  "bindings",
  "expect",
  "deviation",
  "divergence",
]);
const DIALECT_ROW_KEYS = new Set([
  "id",
  "tag",
  "source",
  "declarations",
  "functions",
  "bindings",
  "context",
  "explain",
  "rootsDeclared",
  "couldNameModule",
  "modules",
  "expect",
]);
const MODULE_FUNCTION_KEYS = ["returns", "deterministic", "hostBacked", "resultSchema", "result", "error"];
const OUT_OF_DOMAIN_TYPES = ["int", "uint", "google.protobuf.Timestamp", "google.protobuf.Duration"];

interface LanguageFile {
  celSpec: { commit: string };
  rows: LanguageRow[];
}

const language = JSON.parse(readFileSync(new URL("language.json", DIRECTORY), "utf8")) as LanguageFile;
const readme = readFileSync(new URL("README.md", DIRECTORY), "utf8");
const env = buildCelLanguageEnvironment();
const codec = conformanceValueCodec(env);

interface DialectFile {
  rows: DialectRow[];
}

const readDialectFile = (name: string) =>
  JSON.parse(readFileSync(new URL(name, DIRECTORY), "utf8")) as DialectFile;
const dialectFiles: Record<string, DialectFile> = Object.fromEntries(
  DIALECT_FILES.map((name) => [name, readDialectFile(name)]),
);
const dialectEnv = buildCelEnvironment(CONFORMANCE_HANDLERS);
const dialectCodec = conformanceValueCodec(dialectEnv);

let dispatchedByRow: string[] = [];
const tracingEnv = dispatchTracingEnvironment(CONFORMANCE_HANDLERS, (signature) => dispatchedByRow.push(signature));

/** Every type a declaration names, record fields included. */
function declaredTypes(declaration: Declaration): string[] {
  return typeof declaration === "string"
    ? [declaration]
    : Object.values(declaration.fields).flatMap(declaredTypes);
}

/** The README's `## Divergences` table, one entry per line below its header. */
function readDivergenceTable(text: string): { id: string; nodeAnswers: string; error: string }[] {
  const section = /^## Divergences\n([\s\S]*?)(?=^## )/m.exec(text);
  if (!section) throw new Error("README.md has no '## Divergences' section");
  const lines = section[1]!.split("\n").filter((line) => line.startsWith("|"));
  if (lines[0] !== "| Row | Node answers | Error |" || lines[1] !== "| --- | --- | --- |") {
    throw new Error("README.md's divergence table does not open with its header");
  }
  return lines.slice(2).map((line) => {
    const cells = /^\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \|$/.exec(line);
    if (!cells) throw new Error(`README.md's divergence table holds a malformed line: ${line}`);
    return { id: cells[1]!, nodeAnswers: cells[2]!, error: cells[3]! };
  });
}

async function assertDivergenceRow(row: LanguageRow): Promise<void> {
  const { nodeOutOfDomain } = row.divergence!;
  expect(checkLanguageRow(env, codec, row), row.id).toStrictEqual(row.expect.check);
  const outcome = await evaluateLanguageRow(env, codec, row);
  if (!("result" in outcome)) throw new Error(`${row.id}: evaluation threw ${outcome.error.message}`);
  expect(() => codec.encode(outcome.result), row.id).toThrow(/Cannot write a conformance value/);
  expect(outOfDomainType(outcome.result), row.id).toBe(nodeOutOfDomain);
  expect(Object.keys(row.expect).sort(), row.id).toEqual(["check", "error"]);
  expect(row.expect.error!.code, row.id).toBeNull();
  const highlight = /\n\n> +(\d+) \| (.*)\n +\^$/.exec(row.expect.error!.message);
  expect(highlight, `${row.id}: the error carries no highlight`).not.toBeNull();
  expect(highlight![2], row.id).toBe(row.source.split("\n")[Number(highlight![1]) - 1]);
}

describe("CEL conformance vectors", () => {
  it("drives every file in the directory", () => {
    const files = readdirSync(DIRECTORY).filter((name) => name !== "README.md");
    expect(files.sort()).toEqual(DRIVEN);
  });

  it("reads a well-formed language file", () => {
    expect(Object.keys(language).sort()).toEqual(["celSpec", "rows"]);
    expect(Object.keys(language.celSpec)).toEqual(["commit"]);
    expect(language.celSpec.commit).toMatch(/^[0-9a-f]{40}$/);
    const ids = new Set<string>();
    for (const row of language.rows) {
      const unknown = Object.keys(row).filter((key) => !ROW_KEYS.has(key));
      expect(unknown, `row ${row.id} carries unknown keys`).toEqual([]);
      expect(row, `row ${row.id} has no expect`).toHaveProperty("expect");
      expect(ids.has(row.id), `row id ${row.id} repeats`).toBe(false);
      ids.add(row.id);
      if (row.divergence) {
        expect(Object.keys(row.divergence), row.id).toEqual(["nodeOutOfDomain"]);
        expect(OUT_OF_DOMAIN_TYPES, row.id).toContain(row.divergence.nodeOutOfDomain);
        const deviation = (row.deviation ?? {}) as { celSpec?: object; uncarried?: unknown };
        expect(Object.keys(deviation).filter((key) => key !== "celSpec" && key !== "uncarried"), row.id).toEqual([]);
        expect(Object.keys(deviation.celSpec ?? {}).filter((key) => key !== "type"), row.id).toEqual([]);
      }
    }
  });

  it("lists exactly the divergence rows in the README's table", () => {
    const listed = readDivergenceTable(readme);
    const rows = language.rows
      .filter((row) => row.divergence)
      .map((row) => ({
        id: row.id,
        nodeAnswers: row.divergence!.nodeOutOfDomain,
        error: row.expect.error!.message.split("\n")[0]!,
      }));
    expect(listed).toStrictEqual(rows);
  });

  it.each(Object.entries(dialectFiles))("reads a well-formed dialect file %s", (name, file) => {
    expect(Object.keys(file), name).toEqual(["rows"]);
    const ids = new Set<string>();
    for (const row of file.rows) {
      const unknown = Object.keys(row).filter((key) => !DIALECT_ROW_KEYS.has(key));
      expect(unknown, `row ${row.id} carries unknown keys`).toEqual([]);
      for (const key of ["id", "tag", "source", "expect"]) {
        expect(row, `row ${row.id} has no ${key}`).toHaveProperty(key);
      }
      expect(DIALECT_TAGS, row.id).toContain(row.tag);
      expect(ids.has(row.id), `row id ${row.id} repeats`).toBe(false);
      ids.add(row.id);
      if (!row.modules) continue;
      expect(Object.keys(row.modules).filter((key) => key !== "names" && key !== "functions"), row.id).toEqual([]);
      expect(row.modules.names.length, `row ${row.id} names no module`).toBeGreaterThan(0);
      for (const [qualified, fn] of Object.entries(row.modules.functions ?? {})) {
        const at = `${row.id}: ${qualified}`;
        expect(Object.keys(fn).filter((key) => !MODULE_FUNCTION_KEYS.includes(key)), at).toEqual([]);
        for (const key of ["returns", "deterministic", "hostBacked"]) expect(fn, at).toHaveProperty(key);
        expect("result" in fn !== "error" in fn, `${at} scripts exactly one of a result and an error`).toBe(true);
      }
    }
  });

  it("drives the dispatch-tracing environment exactly as the dialect environment registers", () => {
    const signatures = (e: typeof env) => e.getDefinitions().functions.map((fn) => fn.signature);
    expect(signatures(tracingEnv)).toEqual(signatures(dialectEnv));
  });

  let executed = 0;
  const executedDialect: Record<string, number> = Object.fromEntries(DIALECT_FILES.map((name) => [name, 0]));
  const evaluatedOverloads = new Set<string>();

  for (const [name, file] of Object.entries(dialectFiles)) {
    describe(name, () => {
      it.each(file.rows.map((row) => [row.id, row] as const))("%s", async (id, row) => {
        executedDialect[name]!++;
        expect(await runDialectRow(dialectEnv, dialectCodec, row), id).toStrictEqual(row.expect);
        if (name !== "catalog.json" || !("value" in row.expect)) return;
        dispatchedByRow = [];
        await evaluateDialectRow(tracingEnv, dialectCodec, row);
        for (const signature of dispatchedByRow) evaluatedOverloads.add(signature);
      });
    });
  }

  it("evaluates every catalog overload in some catalog.json row", () => {
    const missing = catalogOverloads()
      .map(({ signature }) => signature)
      .filter((signature) => !evaluatedOverloads.has(signature));
    expect(missing).toEqual([]);
  });

  it("fires every catalog literal guard statically in some catalog.json row", () => {
    const fired = new Set<string>();
    for (const row of dialectFiles["catalog.json"]!.rows) {
      for (const diagnostic of row.expect.check.diagnostics) {
        const call = / \(in `([A-Za-z_][A-Za-z0-9_]*)\(/.exec(diagnostic.message);
        if (diagnostic.code === "CEL_INVALID_ARGUMENT" && call) fired.add(call[1]!);
      }
    }
    const guarded = CEL_FUNCTIONS.filter((fn) => fn.checkArgs).map((fn) => fn.name);
    expect(guarded.filter((fnName) => !fired.has(fnName))).toEqual([]);
  });

  it("pins every RE2 parse-error kind in some catalog.json row", () => {
    const pinned = new Set<string>();
    for (const row of dialectFiles["catalog.json"]!.rows) {
      const refusal = /^[A-Za-z]+: invalid RE2 pattern "[^]*": ([^":]+)$/.exec(row.expect.error?.message ?? "");
      if (refusal) pinned.add(refusal[1]!);
    }
    expect(RE2_PATTERN_ERROR_KINDS.filter((kind) => !pinned.has(kind))).toEqual([]);
  });

  it("declares a variable of every nominal brand in some types.json row", () => {
    const declared = new Set(
      dialectFiles["types.json"]!.rows.flatMap((row) => Object.values(row.declarations ?? {}).flatMap(declaredTypes)),
    );
    expect(Object.keys(valueBrandBases()).filter((brand) => !declared.has(brand))).toEqual([]);
  });

  it("reports every code of the engine's verdict vocabulary in some verdicts.json row", () => {
    const diagnosed = new Set<string | null>();
    const thrown = new Set<string | null>();
    for (const row of dialectFiles["verdicts.json"]!.rows) {
      for (const diagnostic of row.expect.check.diagnostics) diagnosed.add(diagnostic.code);
      if (row.expect.error) thrown.add(row.expect.error.code);
    }
    expect({
      diagnostics: CEL_VERDICT_CODES.diagnostics.filter((code) => !diagnosed.has(code)),
      errors: CEL_VERDICT_CODES.errors.filter((code) => !thrown.has(code)),
    }).toEqual({ diagnostics: [], errors: [] });
  });

  it("executed every dialect row", () => {
    for (const [name, file] of Object.entries(dialectFiles)) expect(executedDialect[name], name).toBe(file.rows.length);
  });

  describe("language.json", () => {
    it.each(language.rows.map((row) => [row.id, row] as const))("%s", async (id, row) => {
      executed++;
      if (row.divergence) await assertDivergenceRow(row);
      else expect(await runLanguageRow(env, codec, row), id).toStrictEqual(row.expect);
    });
  });

  it("executed every row", () => {
    expect(executed).toBe(language.rows.length);
  });
});

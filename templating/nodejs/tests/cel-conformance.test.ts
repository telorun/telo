/**
 * The CEL conformance vectors (`templating/cel-conformance/README.md`), as far as they are
 * THIS package's to answer.
 *
 * **The language and the catalog are the ENGINE's rows now.** `language.json`,
 * `catalog.json` and `types.json` are replayed by `@telorun/cel`'s own four drivers
 * (`cel/nodejs/conformance/`), which carry the corrections and exclusions a replaced engine's
 * recording needs and pin each group's row count. Driving them a second time here would
 * answer the same row class in different words, and would have to reproduce that accounting
 * to stay green.
 *
 * What is left is the **tag layer**, which no other driver answers: `holes.json`,
 * `module-calls.json` and `verdicts.json` — the hole grammar through `!interpolate` and
 * `!sql`, module-call resolution and dispatch, and every verdict code the three tag engines
 * emit. Beside them stay the vectors' own self-consistency gates and the coverage gates over
 * the catalog and the value brands, which are mechanical facts about the FILES rather than a
 * second answer to a row.
 */
import { readdirSync, readFileSync } from "node:fs";
import { valueBrandBases } from "@telorun/sdk";
import { catalogGuardedNames, RE2_PATTERN_ERROR_KINDS } from "@telorun/cel";
import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";
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
import { conformanceValueCodec, unpairedSurrogateAt } from "./cel-conformance-value.js";

const DIRECTORY = new URL("../../cel-conformance/", import.meta.url);
/** The tag layer: every row of each is answered here. */
const DRIVEN_FILES = ["holes.json", "module-calls.json", "verdicts.json"];
/** Answered by `@telorun/cel`'s own replay; read here only for the coverage gates. */
const ENGINE_FILES = ["catalog.json", "types.json", "language.json"];
const FILES = [...DRIVEN_FILES, ...ENGINE_FILES].sort();
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

interface DialectFile {
  rows: DialectRow[];
}

const readFile = (name: string) =>
  JSON.parse(readFileSync(new URL(name, DIRECTORY), "utf8")) as DialectFile;
const dialectFiles: Record<string, DialectFile> = Object.fromEntries(
  DRIVEN_FILES.map((name) => [name, readFile(name)]),
);
const catalogRows = readFile("catalog.json").rows;
const typeRows = readFile("types.json").rows;

const dialectEnv = buildCelEnvironment(CONFORMANCE_HANDLERS);
const dialectCodec = conformanceValueCodec();

let dispatchedByRow: string[] = [];
const tracingEnv = dispatchTracingEnvironment(CONFORMANCE_HANDLERS, (signature) => dispatchedByRow.push(signature));

/** Every type a declaration names, record fields included. */
function declaredTypes(declaration: Declaration): string[] {
  return typeof declaration === "string"
    ? [declaration]
    : Object.values(declaration.fields).flatMap(declaredTypes);
}

describe("CEL conformance vectors", () => {
  it("accounts for every file in the directory", () => {
    const files = readdirSync(DIRECTORY).filter((name) => name !== "README.md");
    expect(files.sort()).toEqual(FILES);
  });

  it.each(FILES)("holds no string with an unpaired surrogate in %s", (name) => {
    expect(unpairedSurrogateAt(JSON.parse(readFileSync(new URL(name, DIRECTORY), "utf8")))).toBeUndefined();
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
    const signatures = (e: typeof dialectEnv) => e.definitions().functions.map((fn) => fn.signature);
    expect(signatures(tracingEnv)).toEqual(signatures(dialectEnv));
  });

  const executed: Record<string, number> = Object.fromEntries(DRIVEN_FILES.map((name) => [name, 0]));

  for (const [name, file] of Object.entries(dialectFiles)) {
    describe(name, () => {
      it.each(file.rows.map((row) => [row.id, row] as const))("%s", async (id, row) => {
        executed[name]!++;
        expect(await runDialectRow(dialectEnv, dialectCodec, row), id).toStrictEqual(row.expect);
      });
    });
  }

  it("executed every row of every file it drives", () => {
    for (const [name, file] of Object.entries(dialectFiles)) {
      expect(executed[name], name).toBe(file.rows.length);
    }
  });

  /**
   * The coverage gates. Each is a fact about the VECTORS — that some row exercises a thing
   * the dialect declares — rather than a verdict about a row, so they stay here while the
   * rows they read over are answered by the engine's own replay.
   */
  it("evaluates every catalog overload in some catalog.json row", async () => {
    const evaluated = new Set<string>();
    for (const row of catalogRows) {
      if (!("value" in row.expect)) continue;
      dispatchedByRow = [];
      await evaluateDialectRow(tracingEnv, dialectCodec, row);
      for (const signature of dispatchedByRow) evaluated.add(signature);
    }
    const missing = catalogOverloads()
      .map(({ signature }) => signature)
      .filter((signature) => !evaluated.has(signature));
    expect(missing).toEqual([]);
  });

  it("fires every catalog literal guard statically in some catalog.json row", () => {
    const fired = new Set<string>();
    for (const row of catalogRows) {
      for (const diagnostic of row.expect.check.diagnostics) {
        const call = / \(in `([A-Za-z_][A-Za-z0-9_]*)\(/.exec(diagnostic.message);
        if (diagnostic.code === "CEL_INVALID_ARGUMENT" && call) fired.add(call[1]!);
      }
    }
    expect(catalogGuardedNames().filter((name) => !fired.has(name))).toEqual([]);
  });

  it("pins every RE2 parse-error kind in some catalog.json row", () => {
    const pinned = new Set<string>();
    for (const row of catalogRows) {
      const refusal = /^[A-Za-z]+: invalid RE2 pattern "[^]*": ([^":]+)$/.exec(row.expect.error?.message ?? "");
      if (refusal) pinned.add(refusal[1]!);
    }
    expect(RE2_PATTERN_ERROR_KINDS.filter((kind) => !pinned.has(kind))).toEqual([]);
  });

  it("declares a variable of every nominal brand in some types.json row", () => {
    const declared = new Set(
      typeRows.flatMap((row) => Object.values(row.declarations ?? {}).flatMap(declaredTypes)),
    );
    expect(Object.keys(valueBrandBases()).filter((brand) => !declared.has(brand))).toEqual([]);
  });

  /**
   * Codes the vocabulary carries because `analyze` FORWARDS the engine's own union — the type
   * holds every emit site to the list, so a forwarded code has to be in it — and which these
   * engines nonetheless cannot produce, so no row can pin one. Declared here rather than
   * silently missing, and held to being unreachable below.
   *
   * All four need an environment these engines do not build. A module's names are registered
   * `open`, which answers nothing for a name the host declared no function for, and they
   * withhold the parameter list, so there is no arity and no argument to mismatch — whether a
   * call reaches a function and whether it fits are the analyzer's verdicts against its own
   * environment. `CEL_TYPE_ARGUMENT_MISMATCH` needs a parameterized value type on both sides,
   * and the brands registered here are nominal: a type argument is the schema layer's and is
   * erased at the CEL boundary.
   */
  const UNREACHABLE_DIAGNOSTICS = [
    "CEL_TYPE_ARGUMENT_MISMATCH",
    "FUNCTION_ARGUMENT_MISMATCH",
    "FUNCTION_ARITY_MISMATCH",
    "FUNCTION_UNRESOLVED",
  ];

  it("reports every code of the engine's verdict vocabulary in some verdicts.json row", () => {
    const diagnosed = new Set<string | null>();
    const thrown = new Set<string | null>();
    for (const row of dialectFiles["verdicts.json"]!.rows) {
      for (const diagnostic of row.expect.check.diagnostics) diagnosed.add(diagnostic.code);
      if (row.expect.error) thrown.add(row.expect.error.code);
    }
    expect({
      diagnostics: CEL_VERDICT_CODES.diagnostics.filter(
        (code) => !diagnosed.has(code) && !UNREACHABLE_DIAGNOSTICS.includes(code),
      ),
      errors: CEL_VERDICT_CODES.errors.filter((code) => !thrown.has(code)),
    }).toEqual({ diagnostics: [], errors: [] });
  });

  /** The exclusion earns its place only while it is true: a code a row DOES pin is reachable
   *  after all, and belongs in the gate rather than beside it. */
  it("excludes only codes no verdicts.json row reports", () => {
    const diagnosed = new Set<string | null>();
    for (const row of dialectFiles["verdicts.json"]!.rows) {
      for (const diagnostic of row.expect.check.diagnostics) diagnosed.add(diagnostic.code);
    }
    expect(UNREACHABLE_DIAGNOSTICS.filter((code) => diagnosed.has(code))).toEqual([]);
  });

  /** Every excluded code is still part of the vocabulary — the list names codes the engines
   *  forward, not codes that were dropped from the type. */
  it("excludes only codes the vocabulary declares", () => {
    const declared: readonly string[] = CEL_VERDICT_CODES.diagnostics;
    expect(UNREACHABLE_DIAGNOSTICS.filter((code) => !declared.includes(code))).toEqual([]);
  });
});

/**
 * The CEL conformance vectors (`templating/cel-conformance/README.md`), as far as they are
 * THIS package's to answer.
 *
 * **Every dialect file is the tag engines' whole answer.** `catalog.json`, `types.json`,
 * `holes.json`, `module-calls.json` and `verdicts.json` are driven here, every row through
 * the tag engine it names, and each computed `expect` is compared with the row's by deep
 * equality — no list of rows answered otherwise. `@telorun/cel`'s own replay holds
 * `catalog.json` and `types.json` to the projection of that answer the engine alone gives.
 * `language.json` is the engine's, read here only for the file-set, surrogate and `celCode`
 * gates. Beside the rows stay the vectors' self-consistency gates and the coverage gates,
 * which are mechanical facts about the FILES rather than a second answer to a row.
 *
 * Its blind spot: deep equality pins whatever the engines answered.
 */
import { readdirSync, readFileSync } from "node:fs";
import { celTypeOfValueType, VALUE_TYPES, valueBrandBases } from "@telorun/sdk";
import {
  CEL_CHECK_CODES,
  CEL_EVALUATION_CODES,
  catalogGuardedNames,
  RE2_PATTERN_ERROR_KINDS,
  type CelEngineErrorCode,
} from "@telorun/cel";
import { describe, expect, it } from "vitest";
import { CEL_VERDICT_CODES } from "../src/cel/verdict-codes.js";
import {
  catalogOverloads,
  CONFORMANCE_HANDLERS,
  conformanceEnvironment,
  DIALECT_TAGS,
  dispatchTracingEnvironment,
  evaluateDialectRow,
  runDialectRow,
  withConformanceConversions,
  type ConformanceError,
  type Declaration,
  type DialectRow,
} from "./cel-conformance-dialect.js";
import { conformanceValueCodec, unpairedSurrogateAt } from "./cel-conformance-value.js";

const DIRECTORY = new URL("../../cel-conformance/", import.meta.url);
/** The dialect files: every row of each is answered here. */
const DRIVEN_FILES = ["catalog.json", "types.json", "holes.json", "module-calls.json", "verdicts.json"];
/** The two files the engine's projection also answers, which hold no tag-only site input. */
const ENGINE_PROJECTED_FILES = ["catalog.json", "types.json"];
/** The engine's own file; read here only for the file-set, surrogate and `celCode` gates. */
const LANGUAGE_FILE = "language.json";
const FILES = [...DRIVEN_FILES, LANGUAGE_FILE].sort();
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
/** What a `catalog.json` or `types.json` row may not carry: an input only a tag site has. */
const TAG_SITE_INPUTS = ["context", "explain", "rootsDeclared", "couldNameModule", "modules", "functions"];
const ERROR_KEYS = ["code", "celCode", "message"];
const MODULE_FUNCTION_KEYS = ["returns", "deterministic", "hostBacked", "resultSchema", "result", "error"];

/** Every engine-error code, held complete by its type. */
const ENGINE_ERROR_CODE_SET: Record<CelEngineErrorCode, true> = {
  namespaces_mismatch: true,
  unreadable_expression: true,
  emitted_module_rejected: true,
  signature_too_wide: true,
};
/** An evaluation code no row can reach: evaluation is synchronous, so no thenable reaches it. */
const UNREACHABLE_EVALUATION_CODES = ["async_value_unsupported"];

interface DialectFile {
  rows: DialectRow[];
}

interface LanguageFile {
  rows: { id: string; expect: { error?: ConformanceError } }[];
}

const readFile = <T = DialectFile>(name: string) =>
  JSON.parse(readFileSync(new URL(name, DIRECTORY), "utf8")) as T;
const dialectFiles: Record<string, DialectFile> = Object.fromEntries(
  DRIVEN_FILES.map((name) => [name, readFile(name)]),
);
const languageRows = readFile<LanguageFile>(LANGUAGE_FILE).rows;
const catalogRows = dialectFiles["catalog.json"]!.rows;
const typeRows = dialectFiles["types.json"]!.rows;

const dialectCodec = conformanceValueCodec();
const dialectEnv = conformanceEnvironment(dialectCodec);

let dispatchedByRow: string[] = [];
const tracingEnv = withConformanceConversions(
  dispatchTracingEnvironment(CONFORMANCE_HANDLERS, (signature) => dispatchedByRow.push(signature)),
  dialectCodec,
);

/** Every type a declaration names, record fields included. */
function declaredTypes(declaration: Declaration): string[] {
  return typeof declaration === "string"
    ? [declaration]
    : Object.values(declaration.fields).flatMap(declaredTypes);
}

/** Why a `catalog.json` or `types.json` row is not an engine's question; nothing when it is. */
function engineInputProblems(row: DialectRow): string[] {
  const problems: string[] = [];
  if (row.tag !== "cel") problems.push(`names the tag ${JSON.stringify(row.tag)}; these files ask the cel engine alone`);
  for (const key of TAG_SITE_INPUTS) if (key in row) problems.push(`carries \`${key}\``);
  const read = dialectEnv.parse(row.source).diagnostics[0];
  if (read) problems.push(`does not read: ${read.message}`);
  const error = row.expect.error;
  if (error && (error.code !== null || error.celCode === null)) {
    problems.push(`records an error that is not the engine's: ${JSON.stringify(error)}`);
  }
  return problems;
}

/** Why the errors of a set of rows break the `celCode` rule; the codes they record. */
function celCodeProblems(
  files: readonly { name: string; language: boolean; rows: readonly { id: string; expect: { error?: ConformanceError } }[] }[],
): { problems: string[]; recorded: Set<string> } {
  const allowed = new Set<string>([...CEL_EVALUATION_CODES, ...Object.keys(ENGINE_ERROR_CODE_SET)]);
  const checkCodes = new Set<string>(CEL_CHECK_CODES.filter((code) => code.startsWith("CEL_")));
  const problems: string[] = [];
  const recorded = new Set<string>();
  for (const { name, language, rows } of files) {
    for (const row of rows) {
      const error = row.expect.error;
      if (!error) continue;
      const at = `${name} ${row.id}`;
      if (error.code !== null && error.celCode !== null) problems.push(`${at}: records both a code and a celCode`);
      if (error.celCode === null) continue;
      recorded.add(error.celCode);
      if (!allowed.has(error.celCode) && !(language && checkCodes.has(error.celCode))) {
        problems.push(`${at}: records the celCode ${JSON.stringify(error.celCode)}, outside the vocabulary`);
      }
      if (UNREACHABLE_EVALUATION_CODES.includes(error.celCode)) {
        problems.push(`${at}: records ${error.celCode}, which is held unreachable`);
      }
    }
  }
  for (const code of CEL_EVALUATION_CODES) {
    if (!UNREACHABLE_EVALUATION_CODES.includes(code) && !recorded.has(code)) {
      problems.push(`no row records the evaluation code ${code}`);
    }
  }
  return { problems, recorded };
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

  it.each(Object.entries(dialectFiles))("records every error of %s as { code, celCode, message }", (name, file) => {
    const malformed = file.rows
      .filter((row) => row.expect.error !== undefined)
      .filter((row) => {
        const keys = Object.keys(row.expect.error!);
        return keys.length !== ERROR_KEYS.length || ERROR_KEYS.some((key) => !keys.includes(key));
      })
      .map((row) => row.id);
    expect(malformed, name).toEqual([]);
  });

  it.each(ENGINE_PROJECTED_FILES)("holds %s to questions the engine alone answers", (name) => {
    const refused = dialectFiles[name]!.rows.flatMap((row) =>
      engineInputProblems(row).map((problem) => `${row.id}: ${problem}`),
    );
    expect(refused).toEqual([]);
  });

  it("refuses a catalog.json or types.json row naming another tag or carrying a tag-site input", () => {
    const row: DialectRow = {
      id: "scratch/input",
      tag: "interpolate",
      source: "s.text +",
      context: {},
      expect: {
        check: { diagnostics: [], calls: [], regions: [] },
        error: { code: "ERR_X", celCode: null, message: "x" },
      },
    };
    expect(engineInputProblems(row)).toEqual([
      'names the tag "interpolate"; these files ask the cel engine alone',
      "carries `context`",
      expect.stringMatching(/^does not read: /),
      'records an error that is not the engine\'s: {"code":"ERR_X","celCode":null,"message":"x"}',
    ]);
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
   * the dialect declares — rather than a verdict about a row.
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

  const celCodeFiles = [
    ...Object.entries(dialectFiles).map(([name, file]) => ({ name, language: false, rows: file.rows })),
    { name: LANGUAGE_FILE, language: true, rows: languageRows },
  ];

  it("records every evaluation code as some row's celCode, and only codes of the vocabulary", () => {
    expect(celCodeProblems(celCodeFiles).problems).toEqual([]);
  });

  it("fails the celCode gate on a code no row records, an unreachable one, a stray one and both codes", () => {
    const row = (id: string, error: ConformanceError) => ({ id, expect: { error } });
    const recorded = celCodeProblems(celCodeFiles).recorded;
    const without = celCodeFiles.map((file) => ({
      ...file,
      rows: file.rows.filter((held) => held.expect.error?.celCode !== "unbound_function"),
    }));
    expect(recorded.has("unbound_function")).toBe(true);
    expect(celCodeProblems(without).problems).toEqual(["no row records the evaluation code unbound_function"]);
    const added = [
      ...celCodeFiles,
      {
        name: "scratch.json",
        language: false,
        rows: [
          row("scratch/async", { code: null, celCode: "async_value_unsupported", message: "x" }),
          row("scratch/stray", { code: null, celCode: "CEL_TYPE_ERROR", message: "x" }),
          row("scratch/both", { code: "ERR_X", celCode: "no_such_key", message: "x" }),
        ],
      },
    ];
    expect(celCodeProblems(added).problems).toEqual([
      "scratch.json scratch/async: records async_value_unsupported, which is held unreachable",
      'scratch.json scratch/stray: records the celCode "CEL_TYPE_ERROR", outside the vocabulary',
      "scratch.json scratch/both: records both a code and a celCode",
    ]);
  });

  it("declares a variable of every nominal brand and every type with members in some types.json row", () => {
    const declared = new Set(
      typeRows.flatMap((row) => Object.values(row.declarations ?? {}).flatMap(declaredTypes)),
    );
    const registered = [
      ...Object.keys(valueBrandBases()),
      ...[...VALUE_TYPES.values()].filter((entry) => entry.members !== undefined).map(celTypeOfValueType),
    ];
    expect(registered.filter((type) => !declared.has(type))).toEqual([]);
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

/**
 * Replaying the conformance vectors' **dialect** rows the engine alone can answer:
 * `catalog.json` and `types.json`.
 *
 * Each row's `expect` is the `cel` tag engine's whole answer, which the templating test
 * reproduces. Of that answer this driver computes the part `@telorun/cel` gives by itself —
 * the **projection**: the check's diagnostics (`code`, `message`, `fix`, in order) and its
 * type when clean, then the row's value or its error (`code`, `celCode`, `message`) — and
 * deep-compares it with the same projection of the row. There is no list of rows answered
 * otherwise. What the tag engine adds — the call listing, regions, refs, volatility and the
 * readings an editor builds — is outside the projection, and so is every range.
 *
 * **The host's vocabulary is a parameter, never a name written here.** The nominal types
 * come in as `NominalTypeDefinition`s, the engine's own registration shape, and the driver
 * refuses a row declaring a type name the parameter does not hold rather than inventing one.
 *
 * **A row's two halves are independent, as the format says.** The static half checks
 * against the row's declarations plus the host types; the runtime half evaluates, unchecked,
 * against the bindings with the host types registered too but **no** declarations — a value
 * of a brand IS its base at runtime, which is why a row can record a refusal at check and a
 * value at evaluation (`p + 1` over a port). Every conversion and member a host type declares
 * is bound at runtime to a conformance implementation answering
 * `<name>(<conformance text of each argument>)`, the handler set's rule.
 *
 * Before its answer a row is held to being an engine's question at all: it carries no input
 * only a tag site has, its source reads, and every error it records is the engine's own.
 *
 * Its blind spot: deep equality pins whatever this engine answered.
 */

import { isDeepStrictEqual } from "node:util";
import {
  CelEnvironment,
  registerFunctionCatalog,
  type CelCatalogHandlers,
  type CelValue,
  type NominalTypeDefinition,
  type TypeDeclaration,
} from "../src/index.js";
import { recordedError, type RecordedError } from "./conformance-error.js";
import {
  conformanceText,
  encodeConformanceValue,
  readCanonicalConformanceValue,
  type ConformanceValue,
} from "./conformance-value.js";

/** The two files this driver answers for, each with its row count pinned: a row deleted leaves every other count true. */
export const CATALOG_FILE = "catalog.json";
export const CATALOG_ROWS = 195;
export const TYPES_FILE = "types.json";
export const TYPES_ROWS = 74;

/** The inputs only a tag site has, which a row of these two files may not carry. */
export const TAG_SITE_INPUTS = ["context", "explain", "rootsDeclared", "couldNameModule", "modules", "functions"] as const;

/** A recorded diagnostic of the tag engine's static answer. */
export interface RecordedDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly fix?: { readonly replacement: string };
}

export interface DialectRow {
  readonly id: string;
  readonly tag: string;
  readonly source: string;
  readonly declarations?: Readonly<Record<string, unknown>>;
  readonly bindings?: Readonly<Record<string, unknown>>;
  readonly expect: {
    readonly check: {
      readonly diagnostics: readonly RecordedDiagnostic[];
      readonly type?: string;
      readonly [field: string]: unknown;
    };
    readonly value?: ConformanceValue;
    readonly error?: RecordedError;
  };
}

/** The part of a row's answer the engine gives by itself. */
export interface DialectProjection {
  readonly check: { readonly diagnostics: readonly RecordedDiagnostic[]; readonly type?: string };
  readonly value?: ConformanceValue;
  readonly error?: { readonly code: string | null; readonly celCode: string | null; readonly message: string };
}

/**
 * The conformance handler set: each of the nine host-backed functions answers with its own
 * name and each argument's conformance text. A row then pins exactly what the engine hands
 * the host, and a second engine reproduces the text with its own writer.
 */
export function conformanceHandlers(): CelCatalogHandlers {
  const answer = (name: string, args: readonly CelValue[]): string =>
    `${name}(${args.map((value) => conformanceText(value)).join(", ")})`;
  return {
    sha256: (text) => answer("sha256", [text]),
    md5: (text) => answer("md5", [text]),
    sha1: (text) => answer("sha1", [text]),
    sha512: (text) => answer("sha512", [text]),
    hmac: (algorithm, key, message) => answer("hmac", [algorithm, key, message]),
    base64Encode: (text) => answer("base64Encode", [text]),
    base64Decode: (text) => answer("base64Decode", [text]),
    json: (value) => answer("json", [value]),
    joinPath: (base, relative) => answer("joinPath", [base, relative]),
  };
}

/**
 * The dialect environment: the language environment plus the function catalog, with the
 * conformance handler set installed. The host types are NOT here: each half registers them
 * on a clone of its own (`staticEnvironment`, `runtimeEnvironment`).
 */
export function dialectEnvironment(): CelEnvironment {
  const environment = new CelEnvironment({
    unlistedVariablesAreDyn: true,
    enableOptionalTypes: true,
    homogeneousAggregateLiterals: false,
  });
  registerFunctionCatalog(environment, { handlers: conformanceHandlers() });
  return environment;
}

/** The environment a row is CHECKED in: the host types, then its declarations. */
export function staticEnvironment(
  base: CelEnvironment,
  row: DialectRow,
  hostTypes: readonly NominalTypeDefinition[],
): CelEnvironment {
  const environment = base.clone();
  for (const definition of hostTypes) environment.registerType(definition);
  for (const [name, declaration] of Object.entries(row.declarations ?? {})) {
    environment.registerVariable(name, declaration as TypeDeclaration);
  }
  return environment;
}

/**
 * The environment a row is EVALUATED in: the host types, each conversion and member they
 * declare bound to a conformance implementation, and no declarations.
 */
export function runtimeEnvironment(
  base: CelEnvironment,
  hostTypes: readonly NominalTypeDefinition[],
): CelEnvironment {
  const environment = base.clone();
  for (const definition of hostTypes) {
    environment.registerType(definition);
    for (const written of [...(definition.conversions ?? []), ...(definition.members ?? [])]) {
      const signature = written.replace(/\bSelf\b/g, definition.name);
      const name = /^(?:[^(]*\.)?([A-Za-z_][A-Za-z0-9_]*)\(/.exec(signature)?.[1] ?? signature;
      environment.registerFunction(signature, {
        implementation: (ctx, ...args) =>
          `${name}(${args
            .filter((value) => value !== undefined)
            .map((value) => conformanceText(value as CelValue))
            .join(", ")})`,
      });
    }
  }
  return environment;
}

/** The row's bindings as an activation. Throws on a binding not in its canonical writing. */
function activationOf(row: DialectRow): Record<string, CelValue> {
  const activation: Record<string, CelValue> = Object.create(null) as Record<string, CelValue>;
  for (const [name, node] of Object.entries(row.bindings ?? {})) {
    activation[name] = readCanonicalConformanceValue(node as ConformanceValue);
  }
  return activation;
}

/** An error as the projection holds it: no range. */
function projectedError(error: RecordedError): DialectProjection["error"] {
  return { code: error.code, celCode: error.celCode, message: error.message };
}

/**
 * The engine's projection of a row's answer. The static half is the engine's check in the
 * static environment; the runtime half its own evaluation, unchecked, with the bindings.
 */
export function dialectProjection(
  base: CelEnvironment,
  runtime: CelEnvironment,
  row: DialectRow,
  hostTypes: readonly NominalTypeDefinition[],
): DialectProjection {
  const activation = activationOf(row);
  const checked = staticEnvironment(base, row, hostTypes).check(row.source);
  const check = {
    diagnostics: checked.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.fix ? { fix: { replacement: diagnostic.fix.replacement } } : {}),
    })),
    ...(checked.diagnostics.length === 0 ? { type: checked.typeName } : {}),
  };
  let value: CelValue;
  try {
    value = runtime.evaluate(row.source, activation);
  } catch (cause) {
    return { check, error: projectedError(recordedError(cause)) };
  }
  return { check, value: encodeConformanceValue(value) };
}

/** The same projection of what a row records. */
export function recordedProjection(row: DialectRow): DialectProjection {
  const { diagnostics, type } = row.expect.check;
  return {
    check: { diagnostics, ...(type === undefined ? {} : { type }) },
    ...("value" in row.expect ? { value: row.expect.value } : {}),
    ...(row.expect.error === undefined ? {} : { error: projectedError(row.expect.error) }),
  };
}

/** Why a row is not a question the engine alone answers; nothing when it is. */
export function inputProblems(base: CelEnvironment, row: DialectRow): string[] {
  const held = row as unknown as Record<string, unknown>;
  const problems = TAG_SITE_INPUTS.filter((key) => key in held).map(
    (key) => `carries \`${key}\`, an input only a tag site has`,
  );
  const read = base.parse(row.source).diagnostics[0];
  if (read) problems.push(`does not read: ${read.message}`);
  const error = row.expect?.error;
  if (error !== undefined && (error.code !== null || typeof error.celCode !== "string")) {
    problems.push(`records an error that is not the engine's own: ${JSON.stringify(error)}`);
  }
  return problems;
}

/** Every type name a row's declarations mention, so a missing host type is named. */
function declaredTypeNames(rows: readonly DialectRow[]): readonly string[] {
  const names = new Set<string>();
  const read = (declaration: unknown): void => {
    if (typeof declaration === "string") {
      for (const name of declaration.split(/[<>,\s]+/)) {
        if (/^[A-Z]/.test(name) && !/^[A-Z]$/.test(name)) names.add(name);
      }
      return;
    }
    if (declaration !== null && typeof declaration === "object" && "fields" in declaration) {
      for (const field of Object.values((declaration as { fields: Record<string, unknown> }).fields)) {
        read(field);
      }
    }
  };
  for (const row of rows) for (const declaration of Object.values(row.declarations ?? {})) read(declaration);
  return [...names].sort();
}

/**
 * Which type names a row declares that the supplied host types do not account for. A row
 * the driver cannot build an environment for would otherwise be "answered" by whatever an
 * undeclared name reads as, which is not an answer at all.
 */
export function unknownDeclaredTypes(
  rows: readonly DialectRow[],
  hostTypes: readonly NominalTypeDefinition[],
): readonly string[] {
  const known = new Set(hostTypes.map((definition) => definition.name));
  return declaredTypeNames(rows).filter((name) => !known.has(name));
}

export interface DialectReplayFailure {
  readonly id: string;
  readonly reason: string;
}

export interface DialectReplayReport {
  readonly file: string;
  readonly rows: number;
  /** Rows whose projection was computed and compared. */
  readonly driven: number;
  /** A row breaking the format, or one whose answer cannot be computed. */
  readonly malformed: readonly DialectReplayFailure[];
  /** A row that is not a question the engine alone answers. */
  readonly inputs: readonly DialectReplayFailure[];
  /** A row whose projection is not the engine's. */
  readonly answers: readonly DialectReplayFailure[];
}

export function replayDialectRows(
  file: string,
  rows: readonly DialectRow[],
  hostTypes: readonly NominalTypeDefinition[],
): DialectReplayReport {
  const malformed: DialectReplayFailure[] = [];
  const inputs: DialectReplayFailure[] = [];
  const answers: DialectReplayFailure[] = [];
  const ids = new Set<string>();
  const base = dialectEnvironment();
  const runtime = runtimeEnvironment(base, hostTypes);
  let driven = 0;

  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.source !== "string" || row.expect?.check === undefined) {
      malformed.push({ id: String(row.id), reason: "lacks a string `id`, a string `source` or `expect.check`" });
      continue;
    }
    if (ids.has(row.id)) malformed.push({ id: row.id, reason: "repeats an id" });
    ids.add(row.id);
    const refused = inputProblems(base, row);
    if (refused.length > 0) {
      for (const reason of refused) inputs.push({ id: row.id, reason });
      continue;
    }
    let answer: DialectProjection;
    try {
      answer = dialectProjection(base, runtime, row, hostTypes);
    } catch (cause) {
      malformed.push({ id: row.id, reason: `its answer cannot be computed: ${(cause as Error).message}` });
      continue;
    }
    driven += 1;
    const recorded = recordedProjection(row);
    if (!isDeepStrictEqual(answer, recorded)) {
      answers.push({
        id: row.id,
        reason: `the engine answers ${JSON.stringify(answer)} where the row records ${JSON.stringify(recorded)}`,
      });
    }
  }

  return { file, rows: rows.length, driven, malformed, inputs, answers };
}

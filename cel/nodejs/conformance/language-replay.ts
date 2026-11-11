/**
 * Replaying the CEL conformance vectors' language rows, whole.
 *
 * A row's `expect` is `@telorun/cel`'s whole answer, so the driver computes that answer
 * (`languageAnswer`) and deep-compares it with the row — there is no list of rows answered
 * otherwise. Beside the answer it holds every row to the format: the keys a row may carry,
 * the two classes of row (cel-spec's import, then the authored `telo/` rows), the rules of
 * `deviation`, the `celCode` vocabulary, and the round trip of every source that reads.
 *
 * Its blind spot: deep equality pins whatever this engine answered. `deviation.celSpec` is
 * the only check against cel-spec, and only on the rows that carry one.
 */

import { isDeepStrictEqual } from "node:util";
import {
  CelEnvironment,
  hasUnparsed,
  serializeTree,
  treesEqual,
  type CelValue,
  type ResolvedCall,
  type TypeDeclaration,
} from "../src/index.js";
import {
  checkRefusal,
  LANGUAGE_CEL_CODES,
  recordedError,
  recordedRange,
  type RecordedError,
  type RecordedRange,
} from "./conformance-error.js";
import {
  encodeConformanceValue,
  readCanonicalConformanceValue,
  type ConformanceValue,
} from "./conformance-value.js";

/** The one file of the vectors this driver answers for. */
export const DRIVEN_FILE = "language.json";

/** How many rows the file holds. A row deleted leaves every other count true, so it is pinned. */
export const LANGUAGE_ROWS = 1816;

/** The prefix of an authored row's id: a row cel-spec's import did not produce. */
export const AUTHORED_ROW_PREFIX = "telo/";

export interface RecordedDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly range: RecordedRange;
  readonly fix?: { readonly replacement: string };
}

/** A call the checker resolved: every field it reports, its range as `{ start, end }`. */
export interface RecordedCall {
  readonly name: string;
  readonly form: string;
  readonly namespace?: string;
  readonly arity: number;
  readonly range: RecordedRange;
  readonly signature?: string;
  readonly returns?: string;
  readonly deterministic?: boolean;
  readonly hostBacked?: boolean;
  readonly throws?: readonly string[];
  readonly argumentTypes?: readonly string[];
}

export interface LanguageCheck {
  readonly diagnostics: readonly RecordedDiagnostic[];
  readonly type?: string;
  readonly calls: readonly RecordedCall[];
}

export interface LanguageExpect {
  readonly check: LanguageCheck;
  readonly value?: ConformanceValue;
  readonly error?: RecordedError;
}

export interface LanguageRow {
  readonly id: string;
  readonly source: string;
  readonly provenance?: { readonly file: string; readonly section: string; readonly test: string };
  readonly declarations?: Readonly<Record<string, unknown>>;
  readonly functions?: readonly { readonly signature: string }[];
  readonly bindings?: Readonly<Record<string, unknown>>;
  readonly expect: LanguageExpect;
  readonly deviation?: {
    readonly celSpec?: Readonly<Record<string, unknown>>;
    readonly reason?: string;
    readonly uncarried?: readonly string[];
  };
}

/** The closed set of reasons a row's answer may differ from cel-spec's. */
export const DEVIATION_REASONS = [
  /** The row calls into a cel-go extension library Telo does not ship. */
  "extension-library",
  /** The answer needs a cel-spec typing feature the engine does not carry. */
  "feature-not-carried",
  /** The answer is a name resolved through a container, and Telo declares none. */
  "container-not-declared",
  /** An input of the cel-spec test the row could not carry. */
  "uncarried-input",
] as const;

export type DeviationReason = (typeof DEVIATION_REASONS)[number];

/** The parts of cel-spec's outcome a `deviation.celSpec` may state. */
export const CEL_SPEC_PARTS = ["value", "error", "type", "unknown"] as const;

const ROW_KEYS = ["id", "source", "provenance", "declarations", "functions", "bindings", "expect", "deviation"];
const EXPECT_KEYS = ["check", "value", "error"];
const ERROR_KEYS = ["code", "celCode", "message", "range"];
const DEVIATION_KEYS = ["celSpec", "reason", "uncarried"];
const PROVENANCE_KEYS = ["file", "section", "test"];

/**
 * The language environment: CEL's own library, with unlisted names reading as `dyn`,
 * optional types on and heterogeneous aggregates allowed. Nothing else — no host
 * catalog, no host type.
 */
export function languageEnvironment(): CelEnvironment {
  return new CelEnvironment({
    unlistedVariablesAreDyn: true,
    enableOptionalTypes: true,
    homogeneousAggregateLiterals: false,
  });
}

/** The environment a row is CHECKED in: its declarations and its functions. */
export function checkEnvironment(base: CelEnvironment, row: LanguageRow): CelEnvironment {
  if (!row.declarations && !row.functions) return base;
  const environment = base.clone();
  for (const [name, declaration] of Object.entries(row.declarations ?? {})) {
    environment.registerVariable(name, declaration as TypeDeclaration);
  }
  for (const declared of row.functions ?? []) environment.registerFunction(declared.signature);
  return environment;
}

/**
 * The environment a row is EVALUATED in: its functions, and none of its declarations. A
 * declared function has no implementation, so a call to it answers `unbound_function`.
 */
export function evaluationEnvironment(base: CelEnvironment, row: LanguageRow): CelEnvironment {
  if (!row.functions || row.functions.length === 0) return base;
  const environment = base.clone();
  for (const declared of row.functions) environment.registerFunction(declared.signature);
  return environment;
}

/** The row's bindings as an activation. Throws on a binding not in its canonical writing. */
export function activationOf(row: LanguageRow): Record<string, CelValue> {
  const activation: Record<string, CelValue> = Object.create(null) as Record<string, CelValue>;
  for (const [name, node] of Object.entries(row.bindings ?? {})) {
    activation[name] = readCanonicalConformanceValue(node as ConformanceValue);
  }
  return activation;
}

const CALL_KEYS: readonly (keyof ResolvedCall)[] = [
  "name",
  "form",
  "namespace",
  "arity",
  "range",
  "signature",
  "returns",
  "deterministic",
  "hostBacked",
  "throws",
  "argumentTypes",
];

function recordedCall(call: ResolvedCall): RecordedCall {
  const unknown = Object.keys(call).filter((key) => !(CALL_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new Error(`the checker reports call fields the format does not carry: ${unknown.join(", ")}`);
  }
  const recorded: Record<string, unknown> = {};
  for (const key of CALL_KEYS) {
    const value = call[key];
    if (value === undefined) continue;
    recorded[key] = key === "range" ? recordedRange(call.range) : value;
  }
  return recorded as unknown as RecordedCall;
}

/**
 * The engine's whole answer for a row. The check half runs in the check environment; the
 * evaluation half checks first in the evaluation environment, recording a refusal as the
 * first diagnostic, and otherwise evaluates with the row's bindings.
 */
export function languageAnswer(base: CelEnvironment, row: LanguageRow): LanguageExpect {
  const activation = activationOf(row);
  const checked = checkEnvironment(base, row).check(row.source);
  const check: LanguageCheck = {
    diagnostics: checked.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      range: recordedRange(diagnostic.range),
      ...(diagnostic.fix ? { fix: { replacement: diagnostic.fix.replacement } } : {}),
    })),
    ...(checked.diagnostics.length === 0 ? { type: checked.typeName } : {}),
    calls: checked.calls.map(recordedCall),
  };

  const environment = evaluationEnvironment(base, row);
  const expression = environment.parse(row.source);
  const refusal = environment.check(expression).diagnostics[0];
  if (refusal) return { check, error: checkRefusal(refusal) };
  let value: CelValue;
  try {
    value = environment.compile(expression).evaluate(activation);
  } catch (cause) {
    return { check, error: recordedError(cause) };
  }
  return { check, value: encodeConformanceValue(value) };
}

/** A conformance value as cel-spec's equality sees it: `-0` is `0`. */
function celSpecText(node: ConformanceValue): string {
  const zeroed = (held: ConformanceValue): ConformanceValue => {
    if (Array.isArray(held)) return held.map(zeroed);
    if (held === null || typeof held !== "object") return held;
    if (held["$telo"] === "double" && held.value === "-0") return 0;
    return Object.fromEntries(Object.entries(held).map(([key, inner]) => [key, zeroed(inner)]));
  };
  return JSON.stringify(zeroed(encodeConformanceValue(readCanonicalConformanceValue(node))));
}

/**
 * Whether the answer agrees with one part of cel-spec's outcome, by the vectors' cel-spec
 * rule: values by CEL equality including the type (NaN equals NaN, `-0` equals `0`, maps
 * regardless of order), any error agreeing with an error, a type against `check.type`.
 * No answer of this engine is an unknown set.
 */
export function celSpecPartAgrees(part: string, stated: unknown, answer: LanguageExpect): boolean {
  switch (part) {
    case "value":
      return "value" in answer && celSpecText(stated as ConformanceValue) === celSpecText(answer.value!);
    case "error":
      return answer.error !== undefined;
    case "type":
      return answer.check.type === stated;
    case "unknown":
      return false;
    default:
      throw new Error(`${JSON.stringify(part)} is not a part of cel-spec's outcome`);
  }
}

export interface ReplayFailure {
  readonly id: string;
  readonly reason: string;
}

export interface LanguageReplayReport {
  readonly rows: number;
  /** Rows whose answer was computed and compared. */
  readonly driven: number;
  readonly roundTripped: number;
  readonly unreadable: number;
  /** A row breaking the format: its keys, its class, an input that cannot be built. */
  readonly malformed: readonly ReplayFailure[];
  /** A row whose `expect` is not the engine's answer. */
  readonly answers: readonly ReplayFailure[];
  readonly deviations: readonly ReplayFailure[];
  readonly celCodes: readonly ReplayFailure[];
  readonly roundTrip: readonly ReplayFailure[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

/** Why a row breaks the format, before its answer is computed; nothing when it does not. */
export function rowShapeProblems(row: LanguageRow, afterAuthored: boolean): string[] {
  const problems: string[] = [];
  const raw = row as unknown as Record<string, unknown>;
  if ("divergence" in raw) problems.push("carries `divergence`, which the format no longer has");
  const extra = unknownKeys(raw, ROW_KEYS).filter((key) => key !== "divergence");
  if (extra.length > 0) problems.push(`carries keys the format does not define: ${extra.join(", ")}`);
  if (typeof row.id !== "string") problems.push("has no string `id`");
  if (typeof row.source !== "string") problems.push("has no string `source`");
  const authored = typeof row.id === "string" && row.id.startsWith(AUTHORED_ROW_PREFIX);
  if (authored) {
    if (row.provenance !== undefined) problems.push("is authored and carries `provenance`");
    if (row.deviation !== undefined) problems.push("is authored and carries `deviation`");
  } else {
    if (afterAuthored) problems.push("is a cel-spec row after an authored row; authored rows follow the import");
    const provenance = row.provenance as unknown;
    if (
      !isPlainObject(provenance) ||
      unknownKeys(provenance, PROVENANCE_KEYS).length > 0 ||
      PROVENANCE_KEYS.some((key) => typeof provenance[key] !== "string")
    ) {
      problems.push("is a cel-spec row without a `provenance` of `file`, `section` and `test`");
    }
  }
  for (const declared of row.functions ?? []) {
    if (!isPlainObject(declared) || unknownKeys(declared, ["signature"]).length > 0 || typeof declared.signature !== "string") {
      problems.push(`declares a function that is not \`{ signature }\` alone: ${JSON.stringify(declared)}`);
    }
  }
  if (!isPlainObject(row.expect)) {
    problems.push("has no `expect`");
    return problems;
  }
  const expectExtra = unknownKeys(row.expect, EXPECT_KEYS);
  if (expectExtra.length > 0) problems.push(`\`expect\` carries ${expectExtra.join(", ")}`);
  if (!isPlainObject(row.expect.check)) problems.push("`expect` has no `check`");
  if (("value" in row.expect) === (row.expect.error !== undefined)) {
    problems.push("`expect` carries neither or both of `value` and `error`");
  }
  const error = row.expect.error as unknown;
  if (error !== undefined) {
    if (
      !isPlainObject(error) ||
      unknownKeys(error, ERROR_KEYS).length > 0 ||
      !("code" in error) ||
      !("celCode" in error) ||
      typeof error.message !== "string"
    ) {
      problems.push(`\`expect.error\` is not \`{ code, celCode, message, range? }\`: ${JSON.stringify(error)}`);
    }
  }
  if (row.deviation !== undefined) {
    const deviation = row.deviation as unknown;
    if (!isPlainObject(deviation) || Object.keys(deviation).length === 0) {
      problems.push("carries an empty or malformed `deviation`");
    } else {
      const deviationExtra = unknownKeys(deviation, DEVIATION_KEYS);
      if (deviationExtra.length > 0) problems.push(`\`deviation\` carries ${deviationExtra.join(", ")}`);
      const uncarried = deviation.uncarried;
      if (
        uncarried !== undefined &&
        (!Array.isArray(uncarried) || uncarried.length === 0 || uncarried.some((input) => typeof input !== "string"))
      ) {
        problems.push("`deviation.uncarried` is not a non-empty list of inputs");
      }
      const celSpec = deviation.celSpec;
      if (
        celSpec !== undefined &&
        (!isPlainObject(celSpec) ||
          Object.keys(celSpec).length === 0 ||
          unknownKeys(celSpec, CEL_SPEC_PARTS).length > 0)
      ) {
        problems.push(`\`deviation.celSpec\` is not a non-empty set of ${CEL_SPEC_PARTS.join(", ")}`);
      }
    }
  }
  return problems;
}

/** Q4's rules for a row's `deviation`, against the engine's answer. */
export function deviationProblems(row: LanguageRow, answer: LanguageExpect): string[] {
  const deviation = row.deviation;
  if (!deviation) return [];
  const problems: string[] = [];
  const { celSpec, reason, uncarried } = deviation;
  if ((celSpec === undefined) !== (reason === undefined)) {
    problems.push(
      celSpec === undefined
        ? `states the reason ${JSON.stringify(reason)} with no \`celSpec\``
        : "states cel-spec's outcome with no `reason`",
    );
  }
  if (reason !== undefined && !(DEVIATION_REASONS as readonly string[]).includes(reason)) {
    problems.push(`states the reason ${JSON.stringify(reason)}, which is not one of ${DEVIATION_REASONS.join(", ")}`);
  }
  for (const [part, stated] of Object.entries(celSpec ?? {})) {
    if (celSpecPartAgrees(part, stated, answer)) {
      problems.push(`\`deviation.celSpec.${part}\` agrees with the answer — drop it`);
    }
  }
  if (reason === "uncarried-input" && (uncarried?.length ?? 0) === 0) {
    problems.push("states `uncarried-input` with nothing in `uncarried`");
  }
  if (reason === "container-not-declared" && !(uncarried ?? []).includes("container")) {
    problems.push("states `container-not-declared` and `uncarried` does not hold `container`");
  }
  return problems;
}

/** The `celCode` vocabulary of a language row's error. */
export function celCodeProblems(row: LanguageRow): string[] {
  const error = row.expect.error;
  if (!error) return [];
  const problems: string[] = [];
  if (error.celCode !== null && !LANGUAGE_CEL_CODES.has(error.celCode)) {
    problems.push(`records the celCode ${JSON.stringify(error.celCode)}, which no language answer can carry`);
  }
  if (error.code !== null && error.celCode !== null) problems.push("records both a Telo code and a celCode");
  return problems;
}

function roundTripProblem(environment: CelEnvironment, source: string): string | "unreadable" | undefined {
  const expression = environment.parse(source);
  if (expression.diagnostics.length > 0) return "unreadable";
  if (hasUnparsed(expression.root)) return "read with no diagnostic but left an unparsed hole in the tree";
  const written = serializeTree(expression.root);
  const reread = environment.parse(written);
  if (reread.diagnostics.length > 0) return `wrote ${JSON.stringify(written)}, which does not read back`;
  if (!treesEqual(expression.root, reread.root)) {
    return `wrote ${JSON.stringify(written)}, which reads back as a different expression`;
  }
  return undefined;
}

export function replayLanguageRows(rows: readonly LanguageRow[]): LanguageReplayReport {
  const malformed: ReplayFailure[] = [];
  const answers: ReplayFailure[] = [];
  const deviations: ReplayFailure[] = [];
  const celCodes: ReplayFailure[] = [];
  const roundTrip: ReplayFailure[] = [];
  const ids = new Set<string>();
  const base = languageEnvironment();
  let afterAuthored = false;
  let driven = 0;
  let roundTripped = 0;
  let unreadable = 0;

  for (const row of rows) {
    const shape = rowShapeProblems(row, afterAuthored);
    if (typeof row.id === "string" && row.id.startsWith(AUTHORED_ROW_PREFIX)) afterAuthored = true;
    if (ids.has(row.id)) shape.push("repeats an id");
    ids.add(row.id);
    if (shape.length > 0) {
      for (const reason of shape) malformed.push({ id: row.id, reason });
      continue;
    }

    let answer: LanguageExpect;
    try {
      answer = languageAnswer(base, row);
    } catch (cause) {
      malformed.push({ id: row.id, reason: `its answer cannot be computed: ${(cause as Error).message}` });
      continue;
    }
    driven += 1;
    if (!isDeepStrictEqual(answer, row.expect)) {
      answers.push({
        id: row.id,
        reason: `the engine answers ${JSON.stringify(answer)} where the row records ${JSON.stringify(row.expect)}`,
      });
    }
    for (const reason of deviationProblems(row, answer)) deviations.push({ id: row.id, reason });
    for (const reason of celCodeProblems(row)) celCodes.push({ id: row.id, reason });

    const trip = roundTripProblem(checkEnvironment(base, row), row.source);
    if (trip === "unreadable") unreadable += 1;
    else if (trip === undefined) roundTripped += 1;
    else roundTrip.push({ id: row.id, reason: trip });
  }

  return { rows: rows.length, driven, roundTripped, unreadable, malformed, answers, deviations, celCodes, roundTrip };
}

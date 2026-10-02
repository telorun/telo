/**
 * A language row driven through the language environment's own seams: cel-js's
 * check with the row's declarations, then parse + evaluate without them.
 */
import type { Environment } from "@marcbachmann/cel-js";
import { Duration, UnsignedInt } from "@telorun/sdk";
import type { ConformanceValue, ConformanceValueCodec } from "./cel-conformance-value.js";

export interface ConformanceError {
  code: string | null;
  message: string;
}

export type ConformanceFunction =
  | { signature: string; result: ConformanceValue }
  | { signature: string; error: string };

export type LanguageCheck = { type: string } | { diagnostics: ConformanceError[] };

export interface LanguageExpect {
  check: LanguageCheck;
  value?: ConformanceValue;
  error?: ConformanceError;
}

export type OutOfDomainType = "int" | "uint" | "google.protobuf.Timestamp" | "google.protobuf.Duration";

export interface LanguageRow {
  id: string;
  source: string;
  provenance: { file: string; section: string; test: string };
  declarations?: Record<string, string>;
  functions?: ConformanceFunction[];
  bindings?: Record<string, ConformanceValue>;
  expect: LanguageExpect;
  deviation?: unknown;
  divergence?: { nodeOutOfDomain: OutOfDomainType };
}

const TELO_CODE = /^ERR_[A-Z0-9_]+$/;

const MAX_INT = 2n ** 63n - 1n;
const MIN_INT = -(2n ** 63n);
const MAX_UINT = 2n ** 64n - 1n;
const MIN_INSTANT = -62135596800000;
const MAX_INSTANT = 253402300799999;
const MAX_DURATION_SECONDS = 315576000000n;

/** The CEL type of a value outside the CEL value domain, or undefined for one inside it.
 *  Only the value itself is examined, never what it holds. */
export function outOfDomainType(value: unknown): OutOfDomainType | undefined {
  if (typeof value === "bigint") return value > MAX_INT || value < MIN_INT ? "int" : undefined;
  if (value instanceof UnsignedInt) {
    const raw = value.valueOf();
    return raw > MAX_UINT || raw < 0n ? "uint" : undefined;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return ms > MAX_INSTANT || ms < MIN_INSTANT ? "google.protobuf.Timestamp" : undefined;
  }
  if (value instanceof Duration) {
    const seconds = value.seconds;
    return seconds > MAX_DURATION_SECONDS || seconds < -MAX_DURATION_SECONDS ? "google.protobuf.Duration" : undefined;
  }
  return undefined;
}

export function conformanceError(err: unknown): ConformanceError {
  if (!(err instanceof Error)) throw new Error(`Evaluation threw a non-Error value: ${String(err)}`);
  const code = (err as { code?: unknown }).code;
  return { code: typeof code === "string" && TELO_CODE.test(code) ? code : null, message: err.message };
}

function withFunctions(env: Environment, row: LanguageRow, codec: ConformanceValueCodec): Environment {
  const cloned = env.clone();
  for (const fn of row.functions ?? []) {
    cloned.registerFunction(fn.signature, () => {
      if ("error" in fn) throw new Error(fn.error);
      return codec.decode(fn.result);
    });
  }
  return cloned;
}

export function checkLanguageRow(env: Environment, codec: ConformanceValueCodec, row: LanguageRow): LanguageCheck {
  const checking = withFunctions(env, row, codec);
  for (const [name, type] of Object.entries(row.declarations ?? {})) checking.registerVariable(name, type);
  const checked = checking.check(row.source);
  return checked.valid ? { type: checked.type! } : { diagnostics: [conformanceError(checked.error)] };
}

/** The live result evaluation returns, or the error it throws. */
export async function evaluateLanguageRow(
  env: Environment,
  codec: ConformanceValueCodec,
  row: LanguageRow,
): Promise<{ result: unknown } | { error: ConformanceError }> {
  const evaluating = withFunctions(env, row, codec);
  const activation = Object.fromEntries(
    Object.entries(row.bindings ?? {}).map(([name, value]) => [name, codec.decode(value)]),
  );
  try {
    return { result: await evaluating.parse(row.source)(activation) };
  } catch (err) {
    return { error: conformanceError(err) };
  }
}

export async function runLanguageRow(
  env: Environment,
  codec: ConformanceValueCodec,
  row: LanguageRow,
): Promise<LanguageExpect> {
  const check = checkLanguageRow(env, codec, row);
  const outcome = await evaluateLanguageRow(env, codec, row);
  if ("error" in outcome) return { check, error: outcome.error };
  return { check, value: codec.encode(outcome.result) };
}

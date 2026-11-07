/**
 * An error as the vectors record one: `{ code, celCode, message, range? }`, read from the
 * error that left the seam, never from its cause.
 *
 * `code` is the Telo error code the error carries (`ERR_…`), `celCode` the engine's own
 * code — an evaluation code, or an engine error's — and at most one is non-null. An error
 * carrying no code records both as null. An error carrying any other code is not one the
 * format can record, so the row that raised it is malformed and its runner fails.
 */

import {
  CEL_CHECK_CODES,
  CEL_EVALUATION_CODES,
  CelEngineError,
  CelEvaluationError,
  type CelCheckDiagnostic,
  type CelEngineErrorCode,
  type SourceRange,
} from "../src/index.js";

export interface RecordedRange {
  readonly start: number;
  readonly end: number;
}

export interface RecordedError {
  readonly code: string | null;
  readonly celCode: string | null;
  readonly message: string;
  readonly range?: RecordedRange;
}

/** An error whose code the format has no place for. */
export class UnrecordableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrecordableError";
  }
}

const TELO_ERROR_CODE = /^ERR_[A-Z0-9_]+$/;

/** Every engine-error code, held complete by its type. */
const ENGINE_ERROR_CODE_SET: Record<CelEngineErrorCode, true> = {
  namespaces_mismatch: true,
  unreadable_expression: true,
  emitted_module_rejected: true,
  signature_too_wide: true,
};

export const ENGINE_ERROR_CODES = Object.keys(ENGINE_ERROR_CODE_SET) as readonly CelEngineErrorCode[];

/** The check codes a language row's error may carry: the `CEL_*` verdicts. */
export const CEL_CHECK_ERROR_CODES = CEL_CHECK_CODES.filter((code) => code.startsWith("CEL_"));

/** Every `celCode` a language row may record. */
export const LANGUAGE_CEL_CODES: ReadonlySet<string> = new Set<string>([
  ...CEL_EVALUATION_CODES,
  ...ENGINE_ERROR_CODES,
  ...CEL_CHECK_ERROR_CODES,
]);

export function recordedRange(range: SourceRange): RecordedRange {
  return { start: range[0], end: range[1] };
}

/** The refusal a check made, as the error the evaluation half records for it. */
export function checkRefusal(diagnostic: CelCheckDiagnostic): RecordedError {
  return {
    code: null,
    celCode: diagnostic.code,
    message: diagnostic.message,
    range: recordedRange(diagnostic.range),
  };
}

/** What a thrown error records. Throws `UnrecordableError` for a code the format cannot hold. */
export function recordedError(cause: unknown): RecordedError {
  if (cause instanceof CelEvaluationError) {
    return {
      code: null,
      celCode: cause.code,
      message: cause.message,
      ...(cause.range ? { range: recordedRange(cause.range) } : {}),
    };
  }
  if (cause instanceof CelEngineError) return { code: null, celCode: cause.code, message: cause.message };
  if (!(cause instanceof Error)) {
    throw new UnrecordableError(`a value that is not an error was thrown: ${String(cause)}`);
  }
  const code = (cause as { readonly code?: unknown }).code;
  if (code === undefined) return { code: null, celCode: null, message: cause.message };
  if (typeof code === "string" && TELO_ERROR_CODE.test(code)) {
    return { code, celCode: null, message: cause.message };
  }
  throw new UnrecordableError(
    `${cause.name} carries the code ${JSON.stringify(code)}, which is neither a Telo error code nor the engine's own: ${cause.message}`,
  );
}

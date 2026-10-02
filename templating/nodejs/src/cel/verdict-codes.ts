import { RuntimeError } from "@telorun/sdk";
import type { AnalyzeResult, EngineDiagnostic } from "../engine.js";
import type { CallAudit } from "./diagnose.js";

/** Every code the `!cel`, `!interpolate` and `!sql` engines emit: `diagnostics`
 *  from `analyze`, `errors` thrown by compiling or evaluating. Stated once here;
 *  the types below hold every emit site to it, and the conformance runner
 *  requires a `verdicts.json` row for each. */
export const CEL_VERDICT_CODES = {
  diagnostics: [
    "BINDING_NAME_RESERVED",
    "CEL_INVALID_ARGUMENT",
    "CEL_NULLABLE_ACCESS",
    "CEL_SYNTAX_ERROR",
    "CEL_TYPE_ERROR",
    "CEL_UNKNOWN_FIELD",
    "CEL_UNKNOWN_FUNCTION",
    "CEL_UNKNOWN_IDENTIFIER",
    "CEL_WRONG_CALL_FORM",
    "INTERPOLATION_HOLE_NOT_CONVERTIBLE",
  ],
  errors: ["ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE"],
} as const;

export type CelDiagnosticCode = (typeof CEL_VERDICT_CODES.diagnostics)[number];
export type CelErrorCode = (typeof CEL_VERDICT_CODES.errors)[number];

/** A diagnostic one of the three engines builds. */
export interface CelDiagnostic extends EngineDiagnostic {
  readonly code: CelDiagnosticCode;
}

/** What those engines' `analyze` answers. */
export interface CelAnalyzeResult extends AnalyzeResult {
  readonly diagnostics: readonly CelDiagnostic[];
}

/** The call audit, as those engines read it. */
export interface CelCallAudit extends CallAudit {
  readonly diagnostics: readonly CelDiagnostic[];
  readonly argumentIssues: readonly CelDiagnostic[];
}

/** The one constructor of a coded error those engines throw. */
export function celVerdictError(code: CelErrorCode, message: string): RuntimeError {
  return new RuntimeError(code, message);
}

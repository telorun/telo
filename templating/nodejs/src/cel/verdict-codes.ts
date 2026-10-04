import { RuntimeError } from "@telorun/sdk";
import type { AnalyzeResult, EngineDiagnostic } from "../engine.js";
import type { CallAudit } from "./diagnose.js";

/** Every code the `!cel`, `!interpolate` and `!sql` engines emit: `diagnostics`
 *  from `analyze`, `errors` thrown by compiling or evaluating. Stated once here;
 *  the types below hold every emit site to it, and the conformance runner
 *  requires a `verdicts.json` row for each.
 *
 *  **Four codes the ENGINE decides are deliberately absent**, because these engines cannot
 *  reach them and a code no row can pin is a claim the gate can never satisfy:
 *  `FUNCTION_UNRESOLVED`, `FUNCTION_ARITY_MISMATCH` and `FUNCTION_ARGUMENT_MISMATCH` need a
 *  namespace declared CLOSED and with a parameter list, and a module's names are registered
 *  open and withhold their parameters on purpose — whether a call reaches a function, and
 *  whether its arity and arguments fit, rest on the export gate, the dependency edge and a
 *  JSON Schema per parameter, which are the analyzer's verdicts. `CEL_TYPE_ARGUMENT_MISMATCH`
 *  needs a parameterized value type on both sides, and the brands registered here are
 *  nominal with a base and no parameters. Each is still reported where it IS decided — by
 *  the analyzer, against its own environment. */
export const CEL_VERDICT_CODES = {
  diagnostics: [
    "BINDING_NAME_RESERVED",
    "CEL_INVALID_ARGUMENT",
    "CEL_NULLABLE_ACCESS",
    "CEL_SYNTAX_ERROR",
    "CEL_TYPE_ARGUMENT_MISMATCH",
    "CEL_TYPE_ERROR",
    "CEL_UNKNOWN_FIELD",
    "CEL_UNKNOWN_FUNCTION",
    "CEL_UNKNOWN_IDENTIFIER",
    "CEL_WRONG_CALL_FORM",
    // Forwarded from the engine's checker, which decides them. Whether a module call
    // REACHES a function, and whether its arity and arguments fit, is still the analyzer's
    // verdict against its own environment — these engines register a module's names open and
    // withhold their parameters, so they pass the engine's codes through rather than deciding.
    "FUNCTION_ARGUMENT_MISMATCH",
    "FUNCTION_ARITY_MISMATCH",
    "FUNCTION_UNRESOLVED",
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

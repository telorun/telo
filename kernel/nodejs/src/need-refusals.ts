import { needRefusal, type AnalysisDiagnostic, type NeedRefusal } from "@telorun/analyzer";
import { RuntimeError, type RuntimeErrorCode } from "@telorun/sdk";
import { carriedToRuntime } from "./static-analysis-diagnostics.js";
import { UnresolvedInputsError, type UnresolvedApplicationInput } from "./unresolved-inputs.js";

export type { NeedRefusal };

/** Need refusals raised together with the rest of the analysis's errors, by the
 *  analyzer's rule (`needRefusal`). Carrying `unresolved` makes it a
 *  missing-values refusal a host could have asked about. */
export function needRefusalError(
  refusals: readonly NeedRefusal[],
  others: readonly AnalysisDiagnostic[] = [],
  unresolved?: readonly UnresolvedApplicationInput[],
): RuntimeError {
  const refusal = needRefusal(refusals, others);
  const code = refusal.code as RuntimeErrorCode;
  const diagnostics = refusal.carried.map(carriedToRuntime);
  return unresolved
    ? new UnresolvedInputsError(code, refusal.message, unresolved, diagnostics)
    : new RuntimeError(code, refusal.message, diagnostics);
}

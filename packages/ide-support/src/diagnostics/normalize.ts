import { diagnosticFix, type AnalysisDiagnostic } from "@telorun/analyzer";
import type { DiagnosticContext, NormalizedDiagnostic } from "../types.js";
import { resolveRange } from "./range-resolver.js";
import { resolveSeverity } from "./severity.js";

/** Converts a raw analyzer diagnostic into a host-ready shape:
 *    - Guarantees `range` and `severity`.
 *    - Surfaces the analyzer's `fix` stamp as a structured `suggestions` entry
 *      hosts wire into a CodeAction.
 *  Does not rewrite the message — the analyzer already formatted the
 *  human-readable hint, keeping CLI and IDE output in sync.
 *
 *  One suggestion kind, not one per producer: an unknown kind name and a
 *  mis-called CEL function are the same gesture at the host (replace the value
 *  at this range), and a second kind would mean a second action path in every
 *  editor for no difference the user can see. */
export function normalizeDiagnostic(
  d: AnalysisDiagnostic,
  ctx: DiagnosticContext,
): NormalizedDiagnostic {
  const fix = diagnosticFix(d);
  const suggestions = fix ? [{ kind: "replace" as const, replacement: fix.replacement }] : undefined;

  return {
    range: resolveRange(d, ctx),
    severity: resolveSeverity(d),
    code: d.code !== undefined ? String(d.code) : "",
    source: d.source ?? "telo",
    message: d.message,
    ...(suggestions ? { suggestions } : {}),
    ...(d.data !== undefined ? { data: d.data } : {}),
  };
}

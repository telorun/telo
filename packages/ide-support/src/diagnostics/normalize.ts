import type { AnalysisDiagnostic } from "@telorun/analyzer";
import type { DiagnosticContext, NormalizedDiagnostic } from "../types.js";
import { resolveRange } from "./range-resolver.js";
import { resolveSeverity } from "./severity.js";

/** Converts a raw analyzer diagnostic into a host-ready shape:
 *    - Guarantees `range` and `severity`.
 *    - Surfaces `data.suggestedKind` (stamped by the analyzer for UNDEFINED_KIND)
 *      as a structured `{ kind: "replace-kind", replacement }` entry in
 *      `suggestions`, which editor hosts can wire into CodeActions.
 *  Does not rewrite the message — the analyzer already formatted the human-readable
 *  "Did you mean '…'?" hint, keeping CLI and IDE output in sync. */
export function normalizeDiagnostic(
  d: AnalysisDiagnostic,
  ctx: DiagnosticContext,
): NormalizedDiagnostic {
  const suggestedKind = (d.data as { suggestedKind?: string } | undefined)?.suggestedKind;
  const suggestions = suggestedKind
    ? [{ kind: "replace-kind" as const, replacement: suggestedKind }]
    : undefined;

  return {
    range: resolveRange(d, ctx),
    severity: resolveSeverity(d),
    code: d.code !== undefined ? String(d.code) : "",
    source: d.source ?? "telo",
    message: d.message,
    ...(suggestions ? { suggestions } : {}),
  };
}

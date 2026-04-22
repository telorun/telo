import type { AnalysisDiagnostic } from "@telorun/analyzer";
import { DiagnosticSeverity } from "@telorun/analyzer";

/** Resolves a possibly-undefined analyzer severity to a concrete level.
 *  `Warning` is the default — matches VS Code adapter's prior inline behavior. */
export function resolveSeverity(d: AnalysisDiagnostic): DiagnosticSeverity {
  return d.severity ?? DiagnosticSeverity.Warning;
}

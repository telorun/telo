import type { AnalysisDiagnostic } from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { staticDiagnosticToRuntime } from "./static-analysis-diagnostics.js";

/**
 * The one place the kernel raises the expansion refusals it finds itself — a
 * library's, judged when an import loads it (the entry's own are refused by the
 * load's analysis, a loader position by the parse). They arrive in batches over
 * a whole module, so they are raised together as `ERR_MANIFEST_VALIDATION_FAILED`,
 * each carried as a structured diagnostic under its own code.
 */
export function refuseExpansionConstructs(diagnostics: readonly AnalysisDiagnostic[]): void {
  if (diagnostics.length === 0) return;
  throw new RuntimeError(
    "ERR_MANIFEST_VALIDATION_FAILED",
    diagnostics.map((d) => d.message).join("\n"),
    diagnostics.map(staticDiagnosticToRuntime),
  );
}

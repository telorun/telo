import { assembleGraphDiagnostics } from "./graph-diagnostics.js";
import { libraryMigrationDiagnostics, withLibraryMigrationsApplied } from "./library-migrations/report.js";
import type { LoadedGraph } from "./loaded-types.js";
import type { AnalysisDiagnostic } from "./types.js";

/**
 * What `telo check` reports of `graph`'s entry, before any library's verdict:
 * the load findings (parse, core and library migrations, versions, module
 * files, metadata stamps, import resolution) and the entry's live analysis,
 * the cascade on compromised files held back. The one assembly both the
 * entry's check and each library's verdict read. Browser-safe.
 */
export function assembleEntryDiagnostics(
  graph: LoadedGraph,
  analysis: readonly AnalysisDiagnostic[],
): { diagnostics: AnalysisDiagnostic[]; suppressed: AnalysisDiagnostic[] } {
  return assembleGraphDiagnostics(graph, [
    ...libraryMigrationDiagnostics(graph),
    ...withLibraryMigrationsApplied(graph, analysis),
  ]);
}

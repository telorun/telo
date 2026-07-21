import {
  importResolutionDiagnostics,
  type AnalysisDiagnostic,
  type LoadedGraph,
} from "@telorun/analyzer";
import { findPositions } from "./find-positions.js";

/**
 * Files whose static-analysis output is an unreliable cascade rather than a set
 * of independent defects:
 *
 * - a file that **failed to parse** yields a mangled `toJSON()` tree, so its
 *   analyze-derived diagnostics are spurious;
 * - a file whose **import failed to resolve** has broken kind resolution, so it
 *   emits a wall of secondary `UNDEFINED_KIND` etc. for every use of the missing
 *   alias.
 *
 * Both surface a coded parse / import diagnostic of their own (kept, always);
 * their *analysis* diagnostics are what a host suppresses so the real cause is
 * not buried. Every host computes this set from the one function, so the CLI,
 * VS Code, and telo-editor agree on exactly what is compromised.
 */
export function compromisedFiles(graph: LoadedGraph): Set<string> {
  const entrySource = graph.entry.owner.source;
  const files = new Set<string>();
  for (const d of graph.parseDiagnostics) {
    const f = (d.data as { filePath?: string } | undefined)?.filePath;
    if (f) files.add(f);
  }
  for (const e of graph.errors) files.add(e.fromSource ?? entrySource);
  return files;
}

/**
 * Assemble the complete diagnostic set for a loaded graph and partition it into
 * what to surface (`diagnostics`) and the compromised-file cascade held back
 * (`suppressed`). The presentation policy lives here — not in the analyzer,
 * which only emits raw channels — so every host applies it identically.
 *
 * `diagnostics` folds parse, version-reconciliation, import-resolution, and the
 * *live* analysis diagnostics (those on non-compromised files) into one list,
 * in that order. `suppressed` carries the analysis cascade dropped from
 * compromised files, still available to a host that wants to render it dimmed /
 * as related information rather than hide it.
 *
 * A diagnostic's owning file is resolved via {@link findPositions} (resource
 * identity first), falling back to the raw `data.filePath` — which
 * `findPositions` cannot resolve for a file absent from `graph.modules` (e.g. a
 * parse-failed file) — then the entry source.
 *
 * Single-closure hosts (CLI, VS Code) call this directly. The multi-closure
 * telo-editor drives analysis per closure with bespoke routing, so it consumes
 * {@link compromisedFiles} and {@link importResolutionDiagnostics} on their own
 * — but through the same shared policy, never a private reimplementation.
 */
export function assembleGraphDiagnostics(
  graph: LoadedGraph,
  analysisDiagnostics: AnalysisDiagnostic[],
): { diagnostics: AnalysisDiagnostic[]; suppressed: AnalysisDiagnostic[] } {
  const compromised = compromisedFiles(graph);
  const entrySource = graph.entry.owner.source;
  const live: AnalysisDiagnostic[] = [];
  const suppressed: AnalysisDiagnostic[] = [];
  for (const d of analysisDiagnostics) {
    const rawFilePath = (d.data as { filePath?: string } | undefined)?.filePath;
    const file = findPositions(graph, d.data)?.file ?? rawFilePath ?? entrySource;
    (compromised.has(file) ? suppressed : live).push(d);
  }

  return {
    diagnostics: [
      ...graph.parseDiagnostics,
      ...graph.versionDiagnostics,
      ...importResolutionDiagnostics(graph),
      ...live,
    ],
    suppressed,
  };
}

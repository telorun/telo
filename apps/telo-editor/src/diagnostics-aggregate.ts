import { DiagnosticSeverity, type AnalysisDiagnostic } from "@telorun/analyzer";
import { UNKNOWN_FILE_KEY, type WorkspaceDiagnostics } from "./analysis";
import { normalizePath } from "./loader";
import type { EditorState, ParsedManifest } from "./model";

export interface LocatedDiagnostic {
  filePath: string;
  diagnostic: AnalysisDiagnostic;
}

export interface DiagnosticsSummary {
  /** Worst severity in the summary. DiagnosticSeverity.Error (1) is worst. */
  worstSeverity: DiagnosticSeverity;
  count: number;
  /** Ordered by severity ascending (worst first), then by insertion order. */
  diagnostics: LocatedDiagnostic[];
}

/** Diagnostics without an explicit severity are treated as errors. Keeps
 *  unknown severities visually dominant rather than silently demoting them
 *  below real problems. */
const DEFAULT_SEVERITY: DiagnosticSeverity = DiagnosticSeverity.Error;

function severityOf(d: AnalysisDiagnostic): DiagnosticSeverity {
  return d.severity ?? DEFAULT_SEVERITY;
}

function finalize(located: LocatedDiagnostic[]): DiagnosticsSummary | null {
  if (located.length === 0) return null;
  let worst = severityOf(located[0].diagnostic);
  for (const l of located) {
    const s = severityOf(l.diagnostic);
    if (s < worst) worst = s;
  }
  located.sort((a, b) => severityOf(a.diagnostic) - severityOf(b.diagnostic));
  return { worstSeverity: worst, count: located.length, diagnostics: located };
}

/** Collects diagnostics across `filePaths`. When `resourceName` is supplied,
 *  restricts to `byResource` entries with that name; otherwise includes all
 *  `byResource[*]` entries and `byFile` entries for each path. Shared
 *  implementation for `summarizeResource` and `summarizeFiles` — the public
 *  API stays split for call-site readability. */
function collect(
  state: Pick<EditorState, "diagnostics">,
  filePaths: string[],
  resourceName: string | null,
): LocatedDiagnostic[] {
  const out: LocatedDiagnostic[] = [];
  const { byResource, byFile } = state.diagnostics;
  for (const filePath of filePaths) {
    const byName = byResource.get(filePath);
    if (byName) {
      if (resourceName != null) {
        const list = byName.get(resourceName);
        if (list) {
          for (const d of list) out.push({ filePath, diagnostic: d });
        }
      } else {
        for (const list of byName.values()) {
          for (const d of list) out.push({ filePath, diagnostic: d });
        }
      }
    }
    if (resourceName == null) {
      const fileList = byFile.get(filePath);
      if (fileList) {
        for (const d of fileList) out.push({ filePath, diagnostic: d });
      }
    }
  }
  return out;
}

/** Summary for a single named resource. Pass the full list of files the
 *  module spans (owner + partials) because resources declared in a partial
 *  are keyed by the partial's path in `byResource`. */
export function summarizeResource(
  state: Pick<EditorState, "diagnostics">,
  filePaths: string[],
  resourceName: string,
): DiagnosticsSummary | null {
  return finalize(collect(state, filePaths, resourceName));
}

/** Rollup across an entire module. For each filePath in the list, includes
 *  every entry in byResource[filePath][*] and byFile[filePath]. */
export function summarizeFiles(
  state: Pick<EditorState, "diagnostics">,
  filePaths: string[],
): DiagnosticsSummary | null {
  return finalize(collect(state, filePaths, null));
}

/** Flattens every diagnostic in the workspace. Intended for a future
 *  Problems panel. Includes entries under the UNKNOWN_FILE_KEY sentinel so
 *  diagnostics the analyzer couldn't tie to a file are still surfaced. */
export function summarizeWorkspace(
  state: Pick<EditorState, "diagnostics">,
): DiagnosticsSummary | null {
  const { byResource, byFile } = state.diagnostics;
  const out: LocatedDiagnostic[] = [];
  for (const [filePath, byName] of byResource) {
    for (const list of byName.values()) {
      for (const d of list) out.push({ filePath, diagnostic: d });
    }
  }
  for (const [filePath, list] of byFile) {
    for (const d of list) out.push({ filePath, diagnostic: d });
  }
  return finalize(out);
}

/** The set of files a module spans on disk: owner + every partial discovered
 *  from `resources[].sourceFile`. Normalized and deduplicated. Used to drive
 *  sidebar rollups (WorkspaceTree, Resources/Definitions/Imports sections)
 *  and to resolve the active module for `navigateToDiagnostic`. */
export function getModuleFiles(manifest: ParsedManifest): string[] {
  const ownerKey = normalizePath(manifest.filePath);
  const keys = new Set<string>([ownerKey]);
  for (const r of manifest.resources) {
    if (r.sourceFile) keys.add(normalizePath(r.sourceFile));
  }
  return [...keys];
}

export { UNKNOWN_FILE_KEY };

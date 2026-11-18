import type { ResourceManifest } from "@telorun/sdk";
import { writtenPlaceOf } from "./diagnostic-identity.js";
import { withQuotedPath } from "./quoted-place.js";
import { importAnchoredDiagnostic, type ImportReach } from "./reaching-import.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** A problem a kind document's schema has, at a place in it. */
export interface KindDocumentProblem {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

/** `problem` at the document that holds it. */
export function writtenKindDocumentProblem(m: ResourceManifest, problem: KindDocumentProblem): AnalysisDiagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    code: problem.code,
    source: SOURCE,
    message: `${m.kind} ${problem.message}`,
    data: {
      resource: { kind: m.kind, name: m.metadata?.name as string },
      filePath: (m.metadata as { source?: string } | undefined)?.source,
      path: problem.path,
    },
  };
}

/**
 * `problem` where the entry's author reads it: at the document for the
 * entry's own modules, at the `imports:` entry first reaching a dependency's.
 */
export function kindDocumentProblemDiagnostic(
  m: ResourceManifest,
  ownModule: string | undefined,
  problem: KindDocumentProblem,
  reach: ImportReach,
): AnalysisDiagnostic {
  const written = writtenKindDocumentProblem(m, problem);
  const via = ownModule ? reach.of(ownModule) : undefined;
  return ownModule && via ? importAnchoredDiagnostic(problem.code, ownModule, via, written.message, writtenPlaceOf(written)) : written;
}

/** `diagnostic` recording the place its message quotes, where it is reported
 *  at the place it was found — a dependency's is reported at its import. */
export function quotingWrittenPlace(diagnostic: AnalysisDiagnostic, path: string, quotes: string): AnalysisDiagnostic {
  return (diagnostic.data as { path?: unknown } | undefined)?.path === path ? withQuotedPath(diagnostic, quotes) : diagnostic;
}

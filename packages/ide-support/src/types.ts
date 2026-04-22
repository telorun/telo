// Runtime values (classes, enums) — consumers who need `new AnalysisRegistry()`
// or `DiagnosticSeverity.Error` import from here.
export { AnalysisRegistry, DiagnosticSeverity } from "@telorun/analyzer";

// Pure types.
export type {
  Position,
  Range,
  AnalysisDiagnostic,
  PositionIndex,
} from "@telorun/analyzer";

import type { AnalysisRegistry, DiagnosticSeverity, PositionIndex, Range } from "@telorun/analyzer";

export type CompletionKind = "class" | "enumMember" | "property";

export interface CompletionResult {
  label: string;
  kind: CompletionKind;
  detail?: string;
  documentation?: string;
  insertText?: string;
  snippet?: boolean;
  preselect?: boolean;
  sortText?: string;
}

export interface NormalizedDiagnostic {
  range: Range;
  severity: DiagnosticSeverity;
  code: string;
  source: string;
  message: string;
  suggestions?: Array<{ kind: "replace-kind"; replacement: string }>;
}

export interface DiagnosticContext {
  registry: AnalysisRegistry;
  positionIndex?: PositionIndex;
  sourceLine?: number;
}

import type { OnMount } from "@monaco-editor/react";
import { DiagnosticSeverity, type NormalizedDiagnostic } from "@telorun/ide-support";

type Monaco = Parameters<OnMount>[1];

export function toMonacoMarker(
  n: NormalizedDiagnostic,
  monaco: Monaco,
): Parameters<Monaco["editor"]["setModelMarkers"]>[2][number] {
  const severity =
    n.severity === DiagnosticSeverity.Error
      ? monaco.MarkerSeverity.Error
      : n.severity === DiagnosticSeverity.Warning
        ? monaco.MarkerSeverity.Warning
        : n.severity === DiagnosticSeverity.Information
          ? monaco.MarkerSeverity.Info
          : monaco.MarkerSeverity.Hint;

  return {
    severity,
    message: n.message,
    source: n.source,
    code: n.code || undefined,
    // Monaco uses 1-indexed lines/columns; analyzer uses 0-indexed.
    startLineNumber: n.range.start.line + 1,
    startColumn: n.range.start.character + 1,
    endLineNumber: n.range.end.line + 1,
    endColumn: Math.min(n.range.end.character + 1, Number.MAX_SAFE_INTEGER),
  };
}

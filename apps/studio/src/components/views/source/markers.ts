import type { OnMount } from "@monaco-editor/react";
import { DiagnosticSeverity, DiagnosticTag, type NormalizedDiagnostic } from "@telorun/ide-support";

type Monaco = Parameters<OnMount>[1];

/** Monaco's `MarkerTag` is LSP's `DiagnosticTag` under another name and with
 *  the same values; mapping rather than casting is what keeps a tag Monaco does
 *  not know from reaching it as a bare number. */
function toMonacoTags(
  tags: NormalizedDiagnostic["tags"],
  monaco: Monaco,
): Array<(typeof monaco.MarkerTag)[keyof typeof monaco.MarkerTag]> | undefined {
  const mapped = tags?.flatMap((t) =>
    t === DiagnosticTag.Deprecated
      ? [monaco.MarkerTag.Deprecated]
      : t === DiagnosticTag.Unnecessary
        ? [monaco.MarkerTag.Unnecessary]
        : [],
  );
  return mapped?.length ? mapped : undefined;
}

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

  const tags = toMonacoTags(n.tags, monaco);

  return {
    severity,
    message: n.message,
    source: n.source,
    code: n.code || undefined,
    ...(tags ? { tags } : {}),
    // Monaco uses 1-indexed lines/columns; analyzer uses 0-indexed.
    startLineNumber: n.range.start.line + 1,
    startColumn: n.range.start.character + 1,
    endLineNumber: n.range.end.line + 1,
    endColumn: Math.min(n.range.end.character + 1, Number.MAX_SAFE_INTEGER),
  };
}

import type { TeloDiagnosticData } from "@telorun/editor-protocol";
import type { NormalizedDiagnostic } from "@telorun/ide-support";
import type { Diagnostic, DiagnosticSeverity, DiagnosticTag } from "vscode-languageserver/browser";

/** An ide-support diagnostic as LSP carries it. Severity and tags are LSP's own
 *  vocabularies already, so they pass through; the repair and the resource
 *  stamp ride in `data`, which a client hands back unchanged in a
 *  `codeAction` request — that is how a quick fix round-trips. */
export function toLspDiagnostic(n: NormalizedDiagnostic): Diagnostic {
  const stamp = n.data as { resource?: { kind?: unknown; name?: unknown }; path?: unknown } | undefined;
  const replace = n.suggestions?.find((s) => s.kind === "replace");
  const data: TeloDiagnosticData = {
    ...(replace
      ? { fix: { replacement: replace.replacement, ...(replace.tag ? { tag: replace.tag } : {}) } }
      : {}),
    ...(typeof stamp?.resource?.kind === "string" && typeof stamp.resource.name === "string"
      ? { resource: { kind: stamp.resource.kind, name: stamp.resource.name } }
      : {}),
    ...(typeof stamp?.path === "string" ? { path: stamp.path } : {}),
  };
  return {
    range: n.range,
    severity: n.severity as DiagnosticSeverity,
    ...(n.code ? { code: n.code } : {}),
    source: n.source,
    message: n.message,
    ...(n.tags?.length ? { tags: n.tags as DiagnosticTag[] } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
}

/** A diagnostic the engine raises itself, about the document as a whole. */
export function documentDiagnostic(
  message: string,
  severity: DiagnosticSeverity,
  line = 0,
): Diagnostic {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 0 } },
    severity,
    source: "telo-analyzer",
    message,
  };
}

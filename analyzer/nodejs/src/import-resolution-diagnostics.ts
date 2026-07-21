import type { GraphLoadError, LoadedGraph } from "./loaded-types.js";
import { isLocalPathSource } from "./sources/local-path-ref.js";
import { isRegistryRef } from "./sources/module-ref.js";
import { isOciRef } from "./sources/oci-ref.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** True when `source` is a shape some transport claims — a registry ref, an OCI
 *  ref, an HTTP(S) URL, or a relative/absolute path. A source matching none of
 *  these is malformed (no transport can ever resolve it), which we report
 *  differently from a well-formed ref that simply failed to fetch. */
function isRecognizedSourceShape(source: string): boolean {
  return (
    isRegistryRef(source) ||
    isOciRef(source) ||
    source.startsWith("http://") ||
    source.startsWith("https://") ||
    isLocalPathSource(source)
  );
}

function messageFor(e: GraphLoadError, malformed: boolean): string {
  const authored = e.source ?? e.url;
  const via = e.alias ? `import '${e.alias}' → '${authored}'` : `'${authored}'`;
  if (malformed) {
    return (
      `Cannot resolve ${via}: not a recognized module reference. Expected ` +
      `'namespace/name@version', 'oci://host/repo@tag', 'https://…', or a relative path.`
    );
  }
  return `Cannot resolve ${via}: ${e.error.message}`;
}

/**
 * Convert a graph's import-resolution failures (`graph.errors`) into structured,
 * coded diagnostics. This is the single source of truth for surfacing a broken
 * import — every host (CLI, VS Code, telo-editor) routes these instead of each
 * re-deriving the channel and drifting (the VS Code extension used to drop it
 * entirely, showing nothing for a broken import).
 *
 * The analyzer owns only this raw channel conversion; the *presentation* policy
 * — which analysis cascade to hold back for a compromised file — lives in
 * `@telorun/ide-support`'s `assembleGraphDiagnostics`.
 *
 * Each diagnostic adopts the same `data` shape as version-reconciliation
 * diagnostics — `{ filePath, path: "imports.<alias>" }` — so the shared
 * `findPositions` / `resolveRange` routing anchors it on the offending import
 * line with no host-specific code.
 */
export function importResolutionDiagnostics(graph: LoadedGraph): AnalysisDiagnostic[] {
  return graph.errors.map((e) => {
    const filePath = e.fromSource ?? graph.entry.owner.source;
    const malformed = !isRecognizedSourceShape(e.source ?? e.url);
    const data: { filePath: string; path?: string; sourceLine?: number } = { filePath };
    if (e.alias) data.path = `imports.${e.alias}`;
    if (e.sourceLine !== undefined) data.sourceLine = e.sourceLine;
    return {
      severity: DiagnosticSeverity.Error,
      code: malformed ? "INVALID_IMPORT_SOURCE" : "IMPORT_UNRESOLVED",
      source: SOURCE,
      message: messageFor(e, malformed),
      data,
    };
  });
}

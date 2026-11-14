import type { AnalysisDiagnostic } from "./types.js";

/**
 * A diagnostic's identity: its code, its place (resource, file, path, range)
 * and its message. Two diagnostics with one identity report one defect, so a
 * host combining several analyses — `telo check app app/screens`, an editor
 * with both open — reports it once. Browser-safe.
 */
export function diagnosticIdentity(d: AnalysisDiagnostic): string {
  const data = d.data as
    | { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown }
    | undefined;
  return JSON.stringify([
    d.code,
    data?.resource?.kind,
    data?.resource?.name,
    data?.filePath,
    data?.path,
    d.range ?? null,
    d.message,
  ]);
}

/** Every diagnostic of `lists`, in the order each identity first appears,
 *  each identity once. */
export function unionDiagnostics(...lists: readonly (readonly AnalysisDiagnostic[])[]): AnalysisDiagnostic[] {
  const seen = new Set<string>();
  const out: AnalysisDiagnostic[] = [];
  for (const list of lists) {
    for (const d of list) {
      const identity = diagnosticIdentity(d);
      if (seen.has(identity)) continue;
      seen.add(identity);
      out.push(d);
    }
  }
  return out;
}

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

/** Where a defect is written: the place the check of the module writing it
 *  reports it at. */
export interface WrittenAt {
  readonly resource?: { readonly kind?: unknown; readonly name?: unknown };
  readonly filePath?: string;
  readonly path?: string;
}

/** `place` with only the members it holds. */
export function writtenAt(place: WrittenAt): WrittenAt {
  return {
    ...(place.resource ? { resource: { kind: place.resource.kind, name: place.resource.name } } : {}),
    ...(place.filePath !== undefined ? { filePath: place.filePath } : {}),
    ...(place.path !== undefined ? { path: place.path } : {}),
  };
}

/** Where the defect `d` reports is written: the place an import-anchored
 *  finding carries as `data.writtenAt`, else `d`'s own place. */
export function writtenPlaceOf(d: AnalysisDiagnostic): WrittenAt {
  const data = d.data as
    | { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown; writtenAt?: WrittenAt }
    | undefined;
  if (data?.writtenAt) return data.writtenAt;
  return writtenAt({
    ...(data?.resource ? { resource: { kind: data.resource.kind, name: data.resource.name } } : {}),
    ...(typeof data?.filePath === "string" ? { filePath: data.filePath } : {}),
    ...(typeof data?.path === "string" ? { path: data.path } : {}),
  });
}

/**
 * A defect's identity: its code and where it is written. A finding re-reported
 * at the import reaching the module writing it and that module's own finding
 * share one, though their messages and places differ — what lets one cover the
 * other.
 */
export function defectIdentity(d: AnalysisDiagnostic): string {
  const at = writtenPlaceOf(d);
  return JSON.stringify([d.code, at.resource?.kind, at.resource?.name, at.filePath, at.path]);
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

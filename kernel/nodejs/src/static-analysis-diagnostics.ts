import { DiagnosticSeverity, type AnalysisDiagnostic } from "@telorun/analyzer";
import type { DiagnosticOrigin, RuntimeDiagnostic } from "@telorun/sdk";

/**
 * Carry a static-analysis diagnostic into the runtime failure set.
 *
 * The analyzer's `data` — the file, the field path within it, and the owning
 * resource — travels as `origin`, alongside the diagnostic's own `range` for
 * the failures that have no field path to look up (a YAML parse error knows
 * where the syntax broke but has no parsed tree to index). That is what lets a
 * renderer resolve the same `file:line:col` `telo check` prints; flattening it
 * into `message` leaves `telo run` pointing at nothing, which is the whole
 * reason the two commands used to disagree about one error.
 *
 * The sibling of `init-failure-diagnostics.ts`: both turn a kernel failure set
 * into `RuntimeDiagnostic[]`, one for what static analysis rejected and one for
 * what failed to initialize.
 */
export function staticDiagnosticToRuntime(d: AnalysisDiagnostic): RuntimeDiagnostic {
  const data = d.data as DiagnosticOrigin | undefined;
  const origin: DiagnosticOrigin = {};
  if (data?.filePath !== undefined) origin.filePath = data.filePath;
  if (data?.path !== undefined) origin.path = data.path;
  if (data?.resource !== undefined) origin.resource = data.resource;
  if (d.range !== undefined) origin.range = d.range;
  return {
    // Mapped, not assumed: every current caller passes a pre-filtered error set,
    // but a warning routed through here must not be rendered in red and counted
    // toward the exit code. `AnalysisDiagnostic.severity` is optional and its
    // scale runs Error(1) → Hint(4), so anything looser than Error is a warning.
    severity: (d.severity ?? DiagnosticSeverity.Warning) <= DiagnosticSeverity.Error
      ? "error"
      : "warning",
    message: d.message,
    code: d.code !== undefined ? String(d.code) : undefined,
    resource: describeResource(data?.resource),
    // Only when something is actually set, so `origin` stays usable as the
    // "this came from static analysis" predicate its contract promises.
    ...(Object.keys(origin).length > 0 ? { origin } : {}),
  };
}

/** `Kind.name`, or whichever half is present — a diagnostic carrying only one
 *  of them used to render as `undefined.foo`. */
function describeResource(
  resource: { kind?: string; name?: string } | undefined,
): string | undefined {
  if (!resource) return undefined;
  const parts = [resource.kind, resource.name].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join(".") : undefined;
}

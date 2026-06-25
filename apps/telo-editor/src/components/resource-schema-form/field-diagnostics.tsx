import type { NormalizedDiagnostic } from "@telorun/ide-support";
import { SEVERITY_ICON, SEVERITY_TEXT_COLOR } from "../diagnostics/severity";

/** A diagnostic positioned relative to the form's pointer scope: `segments` is
 *  the analyzer's `data.path` with the form's pointer prefix stripped and split
 *  into canonical segments (the analyzer mixes `.` and `/` notation). */
export interface FieldDiagnostic {
  segments: string[];
  diagnostic: NormalizedDiagnostic;
}

/** Splits a diagnostic `data.path` or JSON pointer into canonical segments.
 *  The analyzer stamps paths in a mix of dot (`variables.X.env`) and slash
 *  (`exports.resources/0`) notation, and selection pointers are JSON pointers
 *  (`/targets/0/inputs`) — normalizing on both separators unifies them. */
export function toSegments(path: string): string[] {
  return path.split(/[./]/).filter((s) => s.length > 0);
}

/** True when `segments` begins with every element of `prefix`. */
export function startsWith(segments: string[], prefix: string[]): boolean {
  if (prefix.length > segments.length) return false;
  return prefix.every((seg, i) => segments[i] === seg);
}

/** Diagnostics whose path falls under `fieldName` — a prefix match on the first
 *  segment, so a nested error (`variables.X.env`) lights its ancestor field
 *  (`variables`) too. */
export function fieldDiagnosticsFor(all: FieldDiagnostic[], fieldName: string): FieldDiagnostic[] {
  return all.filter((d) => d.segments[0] === fieldName);
}

/** Inline severity-coloured notes shown beneath a form field. Renders nothing
 *  when the field carries no diagnostics. */
export function FieldDiagnostics({ diagnostics }: { diagnostics: FieldDiagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {diagnostics.map((d, i) => (
        <div
          key={`${d.diagnostic.code}-${i}`}
          className={`flex items-start gap-1 text-[11px] ${SEVERITY_TEXT_COLOR[d.diagnostic.severity]}`}
        >
          <span aria-hidden className="leading-4">
            {SEVERITY_ICON[d.diagnostic.severity]}
          </span>
          <span className="leading-4">{d.diagnostic.message}</span>
        </div>
      ))}
    </div>
  );
}

import type { DiagnosticSeverity, NormalizedDiagnostic } from "@telorun/ide-support";
import {
  SEVERITY_CHIP_CLASS,
  SEVERITY_LABEL,
  SEVERITY_TEXT_COLOR,
} from "../diagnostics/severity";

/** A diagnostic positioned relative to the form's pointer scope: `segments` is
 *  the analyzer's `data.path` with the form's pointer prefix stripped and split
 *  into canonical segments (the analyzer mixes `.` and `/` notation). */
export interface FieldDiagnostic {
  segments: string[];
  diagnostic: NormalizedDiagnostic;
}

/**
 * Splits a diagnostic `data.path`, a form field path, or a JSON pointer into
 * canonical segments.
 *
 * FOUR spellings of the same address reach this, and an index has two of them.
 * The analyzer writes an array index in BRACKETS (`mounts[0].when`, the
 * `walkCelExpressions` form every CEL diagnostic carries) while a JSON pointer
 * writes it as a segment (`/mounts/0`) and the form's own field paths use dots
 * (`mounts.0.when`); some analyzer paths also mix in a slash
 * (`exports.resources/0`). Treating brackets as ordinary characters left
 * `mounts[0]` as one segment, so a bracketed path matched no scope and no
 * field — every diagnostic inside an array was silently dropped before any
 * field could claim it, which is why the YAML pane showed one the form did not.
 */
export function toSegments(path: string): string[] {
  return path.split(/[./[\]]/).filter((s) => s.length > 0);
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

/**
 * Every diagnostic at or below `fieldPath`, and those naming it exactly.
 *
 * The form's `fieldPath` is the node's own address (`routes.0.returns.1.when`),
 * in the same segments a diagnostic's path splits into — so a node asks about
 * itself rather than each level narrowing a list on the way down.
 *
 * Both are needed, and they answer different questions: what to SAY here (the
 * exact ones, so a message sits at the field it is about instead of under the
 * top-level field that happens to contain it) and what to MARK here (everything
 * below, so an ancestor still shows there is something wrong inside it — which
 * is the only signal left once a message has moved into a collapsed section).
 */
export function diagnosticsUnder(all: FieldDiagnostic[], fieldPath: string): FieldDiagnostic[] {
  const prefix = toSegments(fieldPath);
  return all.filter((d) => startsWith(d.segments, prefix));
}

export function diagnosticsAt(all: FieldDiagnostic[], fieldPath: string): FieldDiagnostic[] {
  const prefix = toSegments(fieldPath);
  return all.filter(
    (d) => d.segments.length === prefix.length && startsWith(d.segments, prefix),
  );
}

/** The most severe diagnostic at or below `fieldPath`, or null. Lowest value is
 *  worst (Error === 1). */
export function worstUnder(
  all: FieldDiagnostic[],
  fieldPath: string,
): DiagnosticSeverity | null {
  const under = diagnosticsUnder(all, fieldPath);
  if (under.length === 0) return null;
  return under.reduce(
    (acc, d) => (d.diagnostic.severity < acc ? d.diagnostic.severity : acc),
    under[0].diagnostic.severity,
  );
}

/** The "something below here is wrong" mark on a field's label. Its own
 *  component because every container renders labels and the alternative is the
 *  same three lines of markup in each, drifting one at a time. */
export function SeverityDot({
  diagnostics,
  fieldPath,
}: {
  diagnostics: FieldDiagnostic[];
  fieldPath: string;
}) {
  const worst = worstUnder(diagnostics, fieldPath);
  if (worst == null) return null;
  return (
    <span aria-hidden className={`ml-1.5 ${SEVERITY_TEXT_COLOR[worst]}`}>
      ●
    </span>
  );
}

/**
 * Inline notes beneath a form field, shaped like the diagnostic popover —
 * severity chip, code, message — so the same finding reads the same wherever it
 * is met. Trimmed to those three: the popover's source and location answer
 * "where is this", which is not a question here, since the note is already
 * beside the field it is about.
 */
export function FieldDiagnostics({ diagnostics }: { diagnostics: FieldDiagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {diagnostics.map((d, i) => (
        <div
          key={`${d.diagnostic.code}-${i}`}
          className="flex flex-col gap-0.5 rounded border border-zinc-200 bg-zinc-50 p-1.5 dark:border-zinc-800 dark:bg-zinc-900/60"
        >
          <div className="flex items-center gap-1.5">
            <span
              className={`rounded px-1 py-px text-[10px] font-medium ${SEVERITY_CHIP_CLASS[d.diagnostic.severity]}`}
            >
              {SEVERITY_LABEL[d.diagnostic.severity]}
            </span>
            {d.diagnostic.code && (
              <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                {d.diagnostic.code}
              </span>
            )}
          </div>
          <span className="text-[11px] leading-4 text-zinc-700 dark:text-zinc-300">
            {d.diagnostic.message}
          </span>
        </div>
      ))}
    </div>
  );
}

import { DiagnosticSeverity } from "@telorun/analyzer";

/** Glyph per severity — a filled dot for errors, triangle for warnings, circled
 *  i for info/hint. Shared by every diagnostic surface (badge, inline field
 *  notes) so they read identically. */
export const SEVERITY_ICON: Record<DiagnosticSeverity, string> = {
  [DiagnosticSeverity.Error]: "●",
  [DiagnosticSeverity.Warning]: "▲",
  [DiagnosticSeverity.Information]: "ⓘ",
  [DiagnosticSeverity.Hint]: "ⓘ",
};

export const SEVERITY_TEXT_COLOR: Record<DiagnosticSeverity, string> = {
  [DiagnosticSeverity.Error]: "text-red-500 dark:text-red-400",
  [DiagnosticSeverity.Warning]: "text-amber-500 dark:text-amber-400",
  [DiagnosticSeverity.Information]: "text-sky-500 dark:text-sky-400",
  [DiagnosticSeverity.Hint]: "text-zinc-500 dark:text-zinc-400",
};

/** Word per severity, as the popover and the inline field note both print it. */
export const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  [DiagnosticSeverity.Error]: "Error",
  [DiagnosticSeverity.Warning]: "Warning",
  [DiagnosticSeverity.Information]: "Info",
  [DiagnosticSeverity.Hint]: "Hint",
};

/** The label's chip. Here rather than beside one of its two callers, so a
 *  diagnostic reads the same wherever it is shown. */
export const SEVERITY_CHIP_CLASS: Record<DiagnosticSeverity, string> = {
  [DiagnosticSeverity.Error]: "bg-red-500/10 text-red-600 dark:text-red-400",
  [DiagnosticSeverity.Warning]: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  [DiagnosticSeverity.Information]: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  [DiagnosticSeverity.Hint]: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
};

/**
 * The widget's own colouring when its value is what a diagnostic is about.
 *
 * Applied to the field's WRAPPER and reaching the control through descendant
 * selectors, because the alternative is an `invalid` prop on every field
 * component — a dozen of them, each free to forget it. Only error and warning
 * colour a control: info and hint say something without claiming the value is
 * wrong.
 */
export function severityFieldClass(severity: DiagnosticSeverity): string | null {
  if (severity === DiagnosticSeverity.Error) return ERROR_FIELD_CLASS;
  if (severity === DiagnosticSeverity.Warning) return WARNING_FIELD_CLASS;
  return null;
}

// Written out per severity rather than composed from a colour name: Tailwind
// generates what it can SEE in the source, so a class built by interpolation is
// a class that does not exist at runtime.
const ERROR_FIELD_CLASS = [
  "[&_input]:border-red-400 [&_input]:bg-red-50",
  "dark:[&_input]:border-red-700 dark:[&_input]:bg-red-950/40",
  "[&_textarea]:border-red-400 [&_textarea]:bg-red-50",
  "dark:[&_textarea]:border-red-700 dark:[&_textarea]:bg-red-950/40",
  "[&_select]:border-red-400 [&_select]:bg-red-50",
  "dark:[&_select]:border-red-700 dark:[&_select]:bg-red-950/40",
  // The CEL box paints its own interior (Monaco), so what reads as "wrong"
  // there is its frame.
  "[&_[data-cel-box]]:border-red-400 [&_[data-cel-box]]:bg-red-50",
  "dark:[&_[data-cel-box]]:border-red-700 dark:[&_[data-cel-box]]:bg-red-950/40",
].join(" ");

const WARNING_FIELD_CLASS = [
  "[&_input]:border-amber-400 [&_input]:bg-amber-50",
  "dark:[&_input]:border-amber-700 dark:[&_input]:bg-amber-950/40",
  "[&_textarea]:border-amber-400 [&_textarea]:bg-amber-50",
  "dark:[&_textarea]:border-amber-700 dark:[&_textarea]:bg-amber-950/40",
  "[&_select]:border-amber-400 [&_select]:bg-amber-50",
  "dark:[&_select]:border-amber-700 dark:[&_select]:bg-amber-950/40",
  "[&_[data-cel-box]]:border-amber-400 [&_[data-cel-box]]:bg-amber-50",
  "dark:[&_[data-cel-box]]:border-amber-700 dark:[&_[data-cel-box]]:bg-amber-950/40",
].join(" ");

/** Border emphasis for a node carrying diagnostics — only error / warning earn
 *  a colored edge; info / hint keep the node's neutral border. */
export function severityBorderClass(severity: DiagnosticSeverity): string | null {
  if (severity === DiagnosticSeverity.Error) return "border-red-400 dark:border-red-500";
  if (severity === DiagnosticSeverity.Warning) return "border-amber-400 dark:border-amber-500";
  return null;
}

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

/** Border emphasis for a node carrying diagnostics — only error / warning earn
 *  a colored edge; info / hint keep the node's neutral border. */
export function severityBorderClass(severity: DiagnosticSeverity): string | null {
  if (severity === DiagnosticSeverity.Error) return "border-red-400 dark:border-red-500";
  if (severity === DiagnosticSeverity.Warning) return "border-amber-400 dark:border-amber-500";
  return null;
}

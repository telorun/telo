/**
 * How a command over a closure reports on stderr: refusals and findings in the
 * `telo check` text format, located in the graph each belongs to, then a count
 * — stdout stays the document or nothing.
 */

import type { AnalysisDiagnostic, LoadedGraph } from "@telorun/analyzer";
import * as path from "node:path";
import { formatAnalysisDiagnostics, type JsonDiagnostic, type Logger } from "../logger.js";
import { outErrLine } from "../output.js";
import type { ClosureRefusal } from "./module-closure.js";

/** Print diagnostics, each against the graph that locates it, and return the
 *  counts. */
export function printClosureDiagnostics(
  groups: ReadonlyArray<{ graph?: LoadedGraph; entryPath: string; diagnostics: readonly AnalysisDiagnostic[] }>,
  log: Logger,
): { errorCount: number; warnCount: number; diagnostics: JsonDiagnostic[] } {
  let errorCount = 0;
  let warnCount = 0;
  const diagnostics: JsonDiagnostic[] = [];
  for (const group of groups) {
    if (group.graph) {
      const counts = formatAnalysisDiagnostics(group.diagnostics, group.graph, log, group.entryPath, "stderr");
      errorCount += counts.errorCount;
      warnCount += counts.warnCount;
      diagnostics.push(...counts.diagnostics);
      continue;
    }
    const at = /^[a-z][a-z0-9+.-]*:\/\//i.test(group.entryPath)
      ? group.entryPath
      : path.relative(process.cwd(), group.entryPath) || group.entryPath;
    for (const d of group.diagnostics) {
      outErrLine(`${at}  ${log.err.error("error")}  ${d.message}${d.code ? `  ${log.err.dim(String(d.code))}` : ""}`);
      errorCount++;
      diagnostics.push({
        file: at,
        line: 1,
        column: 1,
        severity: "error",
        ...(d.code ? { code: String(d.code) } : {}),
        message: d.message,
      });
    }
  }
  return { errorCount, warnCount, diagnostics };
}

/** `1 error`, `2 errors, 1 warning` — the line `telo check` ends with. */
export function countLine(counts: { errorCount: number; warnCount: number }, log: Logger): string {
  const parts: string[] = [];
  if (counts.errorCount > 0) parts.push(log.err.error(`${counts.errorCount} error${counts.errorCount === 1 ? "" : "s"}`));
  if (counts.warnCount > 0) parts.push(log.err.warn(`${counts.warnCount} warning${counts.warnCount === 1 ? "" : "s"}`));
  return parts.join(", ");
}

/** Print a closure's refusals and the count line. */
export function printClosureRefusals(refusals: readonly ClosureRefusal[], log: Logger): void {
  const counts = printClosureDiagnostics(refusals, log);
  outErrLine(countLine(counts, log));
}

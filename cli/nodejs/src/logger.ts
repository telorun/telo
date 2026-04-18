import type { AnalysisDiagnostic, PositionIndex } from "@telorun/analyzer";
import { DiagnosticSeverity } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import type { RuntimeDiagnostic } from "@telorun/kernel";
import * as path from "path";

export function createLogger(verbose: boolean) {
  // Honor FORCE_COLOR / CLICOLOR_FORCE so callers piping stdout (the docker
  // runner, CI, etc.) can still opt into ANSI. Without these, running under a
  // non-TTY wrapper produces plain text even when the consumer can render it.
  const useColor =
    Boolean(process.stdout.isTTY) ||
    Boolean(process.env.FORCE_COLOR) ||
    Boolean(process.env.CLICOLOR_FORCE);
  const wrap = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    info: (...args: any[]) => console.log(...args),
    ok: (text: string) => wrap("32", text),
    warn: (text: string) => wrap("33", text),
    error: (text: string) => wrap("31", text),
    dim: (text: string) => wrap("2", text),
    verbose,
  };
}

export type Logger = ReturnType<typeof createLogger>;

export function formatDiagnostics(
  diagnostics: RuntimeDiagnostic[],
  log: Logger,
  displayPath: string,
): void {
  for (const d of diagnostics) {
    const severityLabel = d.severity === "warning" ? log.warn("warning") : log.error("error");
    const who = d.resource ? `${d.resource}: ` : "";
    const code = d.code ? `  ${log.dim(d.code)}` : "";
    console.error(`${displayPath}  ${severityLabel}  ${who}${d.message}${code}`);
  }
}

/** Format analysis diagnostics with file:line:col locations resolved from manifest metadata. */
export function formatAnalysisDiagnostics(
  diagnostics: AnalysisDiagnostic[],
  manifests: ResourceManifest[],
  log: Logger,
  entryPath: string,
): { errorCount: number; warnCount: number } {
  const manifestByKey = new Map<string, ResourceManifest>();
  for (const m of manifests) {
    if (m.kind && m.metadata?.name) {
      manifestByKey.set(`${m.kind}.${m.metadata.name}`, m);
    }
  }

  let errorCount = 0;
  let warnCount = 0;

  for (const d of diagnostics) {
    const resource = (d.data as any)?.resource as { kind: string; name: string } | undefined;
    const m = resource ? manifestByKey.get(`${resource.kind}.${resource.name}`) : undefined;
    const absSource = (m?.metadata as any)?.source as string | undefined;
    const raw = absSource ?? entryPath;
    const displaySource = raw.includes("://") ? raw : path.relative(process.cwd(), raw);
    const sourceLine = (m?.metadata as any)?.sourceLine as number | undefined;
    const positionIndex = (m?.metadata as any)?.positionIndex as PositionIndex | undefined;
    const fieldPath = (d.data as any)?.path as string | undefined;

    const fieldRange =
      fieldPath !== undefined && positionIndex ? positionIndex.get(fieldPath) : undefined;
    const line = (fieldRange?.start.line ?? sourceLine ?? 0) + 1;
    const col = (fieldRange?.start.character ?? 0) + 1;

    const loc = `${displaySource}:${line}:${col}`;
    const severityLabel =
      (d.severity ?? DiagnosticSeverity.Warning) <= DiagnosticSeverity.Error
        ? log.error("error")
        : log.warn("warning");
    const code = d.code ? `  ${log.dim(String(d.code))}` : "";

    console.log(`${loc}  ${severityLabel}  ${d.message}${code}`);

    if ((d.severity ?? DiagnosticSeverity.Warning) <= DiagnosticSeverity.Error) errorCount++;
    else warnCount++;
  }

  return { errorCount, warnCount };
}

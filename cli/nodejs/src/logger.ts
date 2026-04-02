import type { RuntimeDiagnostic } from "@telorun/kernel";

export function createLogger(verbose: boolean) {
  const useColor = process.stdout.isTTY;
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

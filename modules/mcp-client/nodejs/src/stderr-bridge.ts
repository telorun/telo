import { SEVERITY, type Logger, type SeverityNumber } from "@telorun/sdk";

/**
 * Bridge a child MCP server's stderr into log records (`kernel/specs/logging.md`
 * §13.3).
 *
 * A stdio server owns a stream nothing can inject a logger into, so replacement
 * is impossible and bridging is the sanctioned fallback. §13.3 requires a bridge
 * to map the source level onto a `severity_number` and preserve the original
 * spelling in `severity_text` — which is not cosmetic here: a server writing
 * `ERROR: connection lost` would otherwise land at `debug` and be invisible at
 * the default threshold, precisely when it is needed.
 *
 * `observed_timestamp` is deliberately NOT set. §13.3 requires it when the
 * source carries its own origin time; a bare stderr line does not, so the read
 * time IS the only timestamp and claiming otherwise would report a fact we do
 * not have.
 */

/** Static attributes — module scope so the per-line path allocates nothing. */
const STDERR_ATTRIBUTES = { "mcp.transport": "stdio", "mcp.stream": "stderr" } as const;

const LEVELS: ReadonlyArray<readonly [RegExp, SeverityNumber]> = [
  [/^trace\b/i, SEVERITY.trace],
  [/^debug\b/i, SEVERITY.debug],
  [/^info(rmation)?\b/i, SEVERITY.info],
  [/^warn(ing)?\b/i, SEVERITY.warn],
  [/^error\b/i, SEVERITY.error],
  [/^fatal\b/i, SEVERITY.fatal],
  [/^critical\b/i, SEVERITY.fatal],
];

/** A leading level token, in the shapes servers actually emit: `ERROR: msg`,
 *  `[warn] msg`, `WARNING - msg`. Anything else is left alone and defaults to
 *  `debug`, so an unrecognized format degrades to today's behaviour rather than
 *  to a mis-levelled record. */
function classify(line: string): { severity: SeverityNumber; severityText?: string } {
  const match = /^\s*[[(]?\s*([A-Za-z]+)\s*[\])]?\s*[:\-|]?\s+/.exec(line);
  const token = match?.[1];
  if (!token) return { severity: SEVERITY.debug };
  for (const [pattern, severity] of LEVELS) {
    // Preserve the source's own spelling (§5.1), so the mapping stays reversible.
    if (pattern.test(token)) return { severity, severityText: token.toUpperCase() };
  }
  return { severity: SEVERITY.debug };
}

/** Emit one record per complete line. Returns the trailing partial line, which
 *  the caller carries into the next chunk. */
export function bridgeStderrChunk(log: Logger, buffered: string, chunk: string): string {
  const lines = (buffered + chunk).split(/\r?\n/);
  const leftover = lines.pop() ?? "";
  for (const line of lines) {
    if (line.length === 0) continue;
    const { severity, severityText } = classify(line);
    log.log(severity, line, STDERR_ATTRIBUTES, severityText ? { severityText } : undefined);
  }
  return leftover;
}

import type { AnalysisDiagnostic, LoadedGraph } from "@telorun/analyzer";
import { DiagnosticSeverity } from "@telorun/analyzer";
import { findPositions, resolveRange } from "@telorun/ide-support";
import {
  decideColor,
  describeBlockedGroup,
  groupBlockedResources,
  type RuntimeDiagnostic,
} from "@telorun/kernel";
import * as path from "path";
import { fileURLToPath } from "url";

/** Render a manifest source for display: a local `file://` URL (how the loader
 *  canonicalizes on-disk manifests) becomes a CWD-relative path, a real remote
 *  URL (`http(s)://`) is kept absolute, and a bare path is made relative. */
function displaySourcePath(raw: string): string {
  if (raw.startsWith("file://")) {
    return path.relative(process.cwd(), fileURLToPath(raw));
  }
  if (raw.includes("://")) return raw;
  return path.relative(process.cwd(), raw);
}

/** Resolve a diagnostic's manifest site to `file:line:col`. `d` is an analyzer
 *  diagnostic, or a `RuntimeDiagnostic.origin` rebuilt into one — the position
 *  itself comes from `resolveRange`, the rule the VS Code extension already
 *  uses, so `run`, `check` and the editor agree on where an error is instead of
 *  each carrying their own copy. That rule does more than a direct field-path
 *  lookup: it walks parent paths when the leaf is absent from the index (a
 *  `imports.Foo.source` failure lands on `imports.Foo`) and prefers the entry's
 *  key over its value.
 *
 *  Undefined when nothing located it — a diagnostic whose resource is synthetic
 *  and whose file matches no graph source. A pointer to line 1 would be worse
 *  than none: it sends the reader somewhere the error is not. */
function resolveLocation(
  graph: LoadedGraph,
  d: AnalysisDiagnostic,
  fallbackSource: string,
): string | undefined {
  const located = findPositions(graph, d.data);
  if (!located && !d.range) return undefined;
  const range = resolveRange(d, {
    positionIndex: located?.positionIndex,
    sourceLine: located?.sourceLine,
  });
  return `${displaySourcePath(located?.file ?? fallbackSource)}:${range.start.line + 1}:${range.start.character + 1}`;
}

export function createLogger(verbose: boolean) {
  // The color decision follows `kernel/specs/logging.md` §11.2's precedence
  // order exactly, shared with the `pretty` log encoding rather than
  // reimplemented here. Notably this adds `NO_COLOR` support, which the CLI
  // previously ignored, and stops treating a bare `FORCE_COLOR=0` as "on" —
  // both behavior changes, both required by the spec.
  //
  // The decision is made against stdout, which is where this logger writes.
  const useColor = decideColor({
    setting: "auto",
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
  });
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

/**
 * Render runtime diagnostics. Entries the kernel classified as `derived` (they
 * failed only because a dependency did) collapse into one line per blocked
 * chain — a ten-resource chain is one real error and nine shadows of it, and
 * printing them flat buries the only line a reader can act on. `--verbose`
 * prints every entry in full.
 *
 * An entry the kernel raised from static analysis carries `origin`; given the
 * loaded graph it renders with the same `file:line:col` prefix `telo check`
 * prints, so a manifest error points at its line whichever command surfaced it.
 */
export function formatDiagnostics(
  diagnostics: RuntimeDiagnostic[],
  log: Logger,
  displayPath: string,
  graph?: LoadedGraph,
): void {
  // Column the `error`/`warning` label occupies, so a collapsed group line sits
  // under the resource names it summarizes rather than under the label.
  const NAME_COLUMN = " ".repeat("  error  ".length);

  const render = (entries: RuntimeDiagnostic[], indent: string): void => {
    for (const d of entries) {
      const skip = d.derived && !log.verbose;
      if (!skip) {
        const severityLabel = d.severity === "warning" ? log.warn("warning") : log.error("error");
        const code = d.code ? `  ${log.dim(d.code)}` : "";

        // A static failure that nothing could locate falls through to the
        // resource / bare-path branches below, which at least name what failed.
        const location =
          d.origin && graph
            ? resolveLocation(
                graph,
                { message: d.message, range: d.origin.range, data: d.origin },
                displayPath,
              )
            : undefined;

        // Details sit under the message; how far under depends on which branch
        // printed it, so the branch picks the indent and the printing is one place.
        const printDetails = (detailIndent: string): void => {
          if (!d.details) return;
          for (const line of d.details.split("\n")) {
            console.error(`${detailIndent}${log.dim(line)}`);
          }
        };

        if (location) {
          // Static-analysis failure — the position names the exact spot, so it
          // renders exactly as `telo check` does. Repeating the resource here
          // would duplicate it: an analyzer message already names its own.
          console.error(`${indent}${location}  ${severityLabel}  ${d.message}${code}`);
          printDetails(`${indent}  `);
        } else if (d.resource) {
          // Runtime diagnostic — the failure is pinned to a resource, so the
          // entry manifest path adds no information. Show kind + name + message
          // and any structured details indented below.
          const who = `${d.kind ? `${log.dim(d.kind)} ` : ""}${d.resource}`;
          console.error(`${indent}  ${severityLabel}  ${who}: ${d.message}${code}`);
          printDetails(`${indent}${NAME_COLUMN}  `);
        } else {
          // Non-resource diagnostic (e.g. loader/parse failure) — keep the file
          // path since it is the only location cue we have.
          console.error(`${indent}${displayPath}  ${severityLabel}  ${d.message}${code}`);
          printDetails(`${indent}  `);
        }
      }

      // A nested context's failures (an import initializing its library) render
      // one level in — for a collapsed parent too, since a child context's root
      // causes are not shadows of THIS context's failure.
      if (d.children?.length) render(d.children, `${indent}    `);
    }

    if (!log.verbose) {
      for (const [blockedBy, names] of groupBlockedResources(entries)) {
        console.error(`${indent}${NAME_COLUMN}${log.dim(describeBlockedGroup(blockedBy, names))}`);
      }
    }
  };

  render(diagnostics, "");
}

/** Format analysis diagnostics with file:line:col locations resolved via
 *  the canonical `LoadedGraph` — no need to thread positionIndex through
 *  manifest metadata. */
export function formatAnalysisDiagnostics(
  diagnostics: AnalysisDiagnostic[],
  graph: LoadedGraph,
  log: Logger,
  entryPath: string,
): { errorCount: number; warnCount: number } {
  let errorCount = 0;
  let warnCount = 0;

  for (const d of diagnostics) {
    // `check` prints one line per diagnostic and has no resource-named form to
    // fall back to, so an unlocatable one still leads with the entry manifest.
    const loc = resolveLocation(graph, d, entryPath) ?? `${displaySourcePath(entryPath)}:1:1`;
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


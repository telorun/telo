import type { AnalysisDiagnostic, LoadedGraph } from "@telorun/analyzer";
import { DiagnosticSeverity } from "@telorun/analyzer";
import { findPositions, resolveRange } from "@telorun/ide-support";
import {
  describeBlockedGroup,
  groupBlockedResources,
  type RuntimeDiagnostic,
} from "@telorun/kernel";
import * as path from "path";
import { fileURLToPath } from "url";
import { output } from "./output.js";

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
function resolveLocationParts(
  graph: LoadedGraph,
  d: AnalysisDiagnostic,
  fallbackSource: string,
): { file: string; line: number; column: number } | undefined {
  const located = findPositions(graph, d.data);
  if (!located && !d.range) return undefined;
  const range = resolveRange(d, {
    positionIndex: located?.positionIndex,
    sourceLine: located?.sourceLine,
  });
  // 1-based for display; the analyzer's own range is 0-based.
  return {
    file: displaySourcePath(located?.file ?? fallbackSource),
    line: range.start.line + 1,
    column: range.start.character + 1,
  };
}

function resolveLocation(
  graph: LoadedGraph,
  d: AnalysisDiagnostic,
  fallbackSource: string,
): string | undefined {
  const parts = resolveLocationParts(graph, d, fallbackSource);
  return parts && `${parts.file}:${parts.line}:${parts.column}`;
}

/** One diagnostic as `-o json` reports it. The shape is the machine contract
 *  that replaces parsing the prose form: `code` is what a caller branches on,
 *  and the location is pre-resolved because deriving it needs the loaded graph,
 *  which the consumer does not have. */
export interface JsonDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  code?: string;
  message: string;
}

/** The logger's colouring delegates to `Output`'s per-stream palettes.
 *
 *  Its methods paint text destined for STDOUT; `log.err` is the same palette
 *  bound to stderr. Which one a caller wants is decided by where it writes, not
 *  by the process — `formatDiagnostics` writes to stderr and `check`'s summary
 *  to stdout, and one shared decision was wrong for whichever stream was
 *  redirected. Under `-o json` both palettes are plain, so structured output
 *  cannot carry escapes. */
export function createLogger(verbose: boolean) {
  const out = output();
  return {
    info: (...args: any[]) => {
      if (!out.isJson) out.line(args.map((a) => String(a)).join(" "));
    },
    ok: (text: string) => out.stdout.ok(text),
    warn: (text: string) => out.stdout.warn(text),
    error: (text: string) => out.stdout.error(text),
    dim: (text: string) => out.stdout.dim(text),
    /** Palette for text written to stderr. */
    err: out.stderr,
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
  const out = output();
  // This renderer writes to stderr throughout, so it paints with the stderr
  // palette — the stdout one may be coloured when stderr is redirected.
  const paint = log.err;

  const render = (entries: RuntimeDiagnostic[], indent: string): void => {
    for (const d of entries) {
      const skip = d.derived && !log.verbose;
      if (!skip) {
        const severityLabel = d.severity === "warning" ? paint.warn("warning") : paint.error("error");
        const code = d.code ? `  ${paint.dim(d.code)}` : "";

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
            out.errLine(`${detailIndent}${paint.dim(line)}`);
          }
        };

        if (location) {
          // Static-analysis failure — the position names the exact spot, so it
          // renders exactly as `telo check` does. Repeating the resource here
          // would duplicate it: an analyzer message already names its own.
          out.errLine(`${indent}${location}  ${severityLabel}  ${d.message}${code}`);
          printDetails(`${indent}  `);
        } else if (d.resource) {
          // Runtime diagnostic — the failure is pinned to a resource, so the
          // entry manifest path adds no information. Show kind + name + message
          // and any structured details indented below.
          const who = `${d.kind ? `${paint.dim(d.kind)} ` : ""}${d.resource}`;
          out.errLine(`${indent}  ${severityLabel}  ${who}: ${d.message}${code}`);
          printDetails(`${indent}${NAME_COLUMN}  `);
        } else {
          // Non-resource diagnostic (e.g. loader/parse failure) — keep the file
          // path since it is the only location cue we have.
          out.errLine(`${indent}${displayPath}  ${severityLabel}  ${d.message}${code}`);
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
        out.errLine(`${indent}${NAME_COLUMN}${paint.dim(describeBlockedGroup(blockedBy, names))}`);
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
): { errorCount: number; warnCount: number; diagnostics: JsonDiagnostic[] } {
  let errorCount = 0;
  let warnCount = 0;
  const out = output();
  const collected: JsonDiagnostic[] = [];

  for (const d of diagnostics) {
    // `check` prints one line per diagnostic and has no resource-named form to
    // fall back to, so an unlocatable one still leads with the entry manifest.
    const parts = resolveLocationParts(graph, d, entryPath) ?? {
      file: displaySourcePath(entryPath),
      line: 1,
      column: 1,
    };
    const isError = (d.severity ?? DiagnosticSeverity.Warning) <= DiagnosticSeverity.Error;
    const severityLabel = isError ? log.error("error") : log.warn("warning");
    const code = d.code ? `  ${log.dim(String(d.code))}` : "";

    // Silent under `-o json`: the structured payload carries the same
    // diagnostics with their location resolved, so printing here too would
    // interleave prose into a document a consumer parses.
    out.line(`${parts.file}:${parts.line}:${parts.column}  ${severityLabel}  ${d.message}${code}`);

    collected.push({
      ...parts,
      severity: isError ? "error" : "warning",
      ...(d.code === undefined ? {} : { code: String(d.code) }),
      message: d.message,
    });

    if (isError) errorCount++;
    else warnCount++;
  }

  return { errorCount, warnCount, diagnostics: collected };
}


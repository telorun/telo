import type { GraphLoadError, LoadedGraph } from "./loaded-types.js";
import { isLocalPathSource } from "./sources/local-path-ref.js";
import { isOciRef } from "./sources/oci-ref.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** True when `source` is a shape some transport claims — an OCI ref, an HTTP(S)
 *  URL, or a relative/absolute path. A source matching none of these is
 *  malformed (no transport can ever resolve it), which we report differently
 *  from a well-formed ref that simply failed to fetch. */
function isRecognizedSourceShape(source: string): boolean {
  return (
    isOciRef(source) ||
    source.startsWith("http://") ||
    source.startsWith("https://") ||
    isLocalPathSource(source)
  );
}

/** Which of the three failures this is. Kept as one function so the code and
 *  the sentence can never disagree about which cause was established. */
function classify(
  e: GraphLoadError,
): "INVALID_IMPORT_TARGET" | "INVALID_IMPORT_SOURCE" | "IMPORT_UNRESOLVED" | "KIND_PREFIX_RESERVED" {
  if (e.reason === "reserved-prefix") return "KIND_PREFIX_RESERVED";
  if (e.reason === "unusable-target") return "INVALID_IMPORT_TARGET";
  return isRecognizedSourceShape(e.source ?? e.url) ? "IMPORT_UNRESOLVED" : "INVALID_IMPORT_SOURCE";
}

/** The removed bare `<namespace>/<name>@<version>` ref: no scheme, not a path,
 *  carrying both a `/` and an `@`. Recognised only to explain itself — no
 *  migration can rewrite it, because the OCI host it moved to is not derivable
 *  from the ref, and the failing line is frequently inside a dependency the
 *  consumer cannot edit. The message is the whole remedy available to them. */
function isRemovedBareRef(source: string): boolean {
  return (
    !source.includes("://") &&
    !source.startsWith("/") &&
    !source.startsWith(".") &&
    source.includes("@") &&
    source.includes("/")
  );
}

function messageFor(e: GraphLoadError, code: ReturnType<typeof classify>): string {
  const authored = e.source ?? e.url;
  const via = e.alias ? `import '${e.alias}' → '${authored}'` : `'${authored}'`;
  if (code === "INVALID_IMPORT_SOURCE") {
    const removedForm = isRemovedBareRef(authored)
      ? ` The bare '<namespace>/<name>@<version>' form was removed — rewrite it to the ` +
        `module's 'oci://' ref (\`telo search <name>\` reports it).`
      : "";
    return (
      `Cannot resolve ${via}: not a recognized module reference. Expected ` +
      `'oci://host/repo@tag', 'https://…', or a relative path.${removedForm}`
    );
  }
  // The target WAS obtained, so "cannot resolve" would name the wrong problem —
  // and the wrong person to fix it. The loader's message already says what was
  // fetched and why it is not importable.
  if (code === "INVALID_IMPORT_TARGET" || code === "KIND_PREFIX_RESERVED") {
    return `Cannot use ${via}: ${e.error.message}`;
  }
  return `Cannot resolve ${via}: ${e.error.message}`;
}

/**
 * Convert a graph's import failures (`graph.errors`) into structured, coded
 * diagnostics. This is the single source of truth for surfacing a broken
 * import — every host (CLI, VS Code, telo studio) routes these instead of each
 * re-deriving the channel and drifting (the VS Code extension used to drop it
 * entirely, showing nothing for a broken import).
 *
 * Three codes, because three different people fix them:
 * `INVALID_IMPORT_SOURCE` (the ref is not a module reference at all),
 * `IMPORT_UNRESOLVED` (a well-formed ref that could not be obtained), and
 * `INVALID_IMPORT_TARGET` (obtained, but not an importable library — an
 * application, the built-in vocabulary, no library document, or one that names
 * no module). Collapsing the last into the second would tell an author to fix a
 * ref that is correct. A fourth, `KIND_PREFIX_RESERVED`, is the import aliased
 * `Telo` / `Self` or reaching a library of that name.
 *
 * This is the raw channel conversion; the *presentation* policy — which
 * analysis cascade to hold back for a compromised file — is
 * `assembleGraphDiagnostics` (`graph-diagnostics.ts`).
 *
 * Each diagnostic adopts the same `data` shape as version-reconciliation
 * diagnostics — `{ filePath, path: "imports.<alias>" }` — so the shared
 * `findPositions` / `resolveRange` routing anchors it on the offending import
 * line with no host-specific code.
 */
export function importResolutionDiagnostics(graph: LoadedGraph): AnalysisDiagnostic[] {
  return importFailureDiagnostics(graph.errors, graph.entry.owner.source);
}

/**
 * The same conversion over import failures no graph recorded — an import the
 * graph walk never reaches, refused where it is loaded. `entrySource` is the
 * file a failure with no `fromSource` is reported against. A failure with no
 * `alias` has no `imports:` entry to anchor on and is located by its file alone.
 */
export function importFailureDiagnostics(
  errors: readonly GraphLoadError[],
  entrySource: string,
): AnalysisDiagnostic[] {
  return errors.map((e) => {
    const filePath = e.fromSource ?? entrySource;
    const code = classify(e);
    const data: { filePath: string; path?: string; sourceLine?: number } = { filePath };
    if (e.alias) data.path = `imports.${e.alias}`;
    if (e.sourceLine !== undefined) data.sourceLine = e.sourceLine;
    return {
      severity: DiagnosticSeverity.Error,
      code,
      source: SOURCE,
      message: messageFor(e, code),
      data,
    };
  });
}

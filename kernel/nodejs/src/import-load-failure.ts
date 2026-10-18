import {
  importFailureDiagnostics,
  type GraphLoadError,
  type LoadedGraph,
} from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { staticDiagnosticToRuntime } from "./static-analysis-diagnostics.js";

/**
 * What a graph that recorded import failures is refused with: one error
 * carrying every import's diagnostic exactly as `telo check` reports it (the
 * import sentence, located at `imports.<alias>`), headed by the first failure's
 * own message. Its code is the first failure's own when the loader raised a
 * coded runtime error — a transport's refusal is never masked — and otherwise
 * the runtime twin of that diagnostic's code: `ERR_INVALID_IMPORT_SOURCE`,
 * `ERR_IMPORT_UNRESOLVED`, `ERR_INVALID_IMPORT_TARGET` or
 * `ERR_KIND_PREFIX_RESERVED`.
 */
export function importLoadFailure(graph: LoadedGraph): RuntimeError {
  return importFailure(graph.errors, graph.entry.owner.source);
}

/**
 * The same refusal for import failures no graph recorded — a `Telo.Import`
 * the graph walk never reached, refused by the import controller when it loads
 * the target. `entrySource` is the file a failure with no `fromSource` is
 * reported against.
 */
export function importFailure(
  errors: readonly GraphLoadError[],
  entrySource: string,
): RuntimeError {
  const [first] = errors;
  if (!first) throw new Error("importFailure called with no import failure");
  const diagnostics = importFailureDiagnostics(errors, entrySource);
  const code =
    first.error instanceof RuntimeError ? first.error.code : `ERR_${String(diagnostics[0]!.code)}`;
  return new RuntimeError(code, first.error.message, diagnostics.map(staticDiagnosticToRuntime));
}

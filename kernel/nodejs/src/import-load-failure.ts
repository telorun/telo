import { importFailureRefusal, type GraphLoadError, type LoadedGraph } from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { loadRefusalError } from "./static-analysis-diagnostics.js";

/**
 * What a graph that recorded import failures is refused with: the analyzer's
 * import-failure refusal (`importFailureRefusal`), the first group of the load
 * refusal rule, raised as the runtime error it is.
 */
export function importLoadFailure(graph: LoadedGraph): RuntimeError {
  return importFailure(graph.errors, graph.entry.owner.source);
}

/**
 * The same refusal for import failures no graph recorded — a `Telo.Import` no
 * load walked (one in a scope a controller builds programmatically), refused by
 * the import controller when it loads the target. `entrySource` is the file a failure with no `fromSource` is
 * reported against.
 */
export function importFailure(errors: readonly GraphLoadError[], entrySource: string): RuntimeError {
  return loadRefusalError(importFailureRefusal(errors, entrySource));
}

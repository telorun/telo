/**
 * The kernel's refusal of a loader stamp an author wrote in `metadata`
 * (`ERR_METADATA_RESERVED_FIELD`): at load over what the loader and the analysis
 * found, and on a declaration the kernel makes itself — one a controller
 * registers inline, a template body entry — which no load may have analysed.
 */
import {
  describeModuleSource,
  metadataStampMessage,
  writtenNestedStamps,
  type AnalysisDiagnostic,
  type LoadedGraph,
} from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { staticDiagnosticToRuntime } from "./static-analysis-diagnostics.js";

/** The load's refusal of `stamps`, each located as `telo check` locates it,
 *  beside every other error the analysis found. */
export function metadataStampLoadRefusal(
  graph: Pick<LoadedGraph, "modules" | "importEdges">,
  stamps: readonly AnalysisDiagnostic[],
  others: readonly AnalysisDiagnostic[] = [],
): RuntimeError {
  return new RuntimeError(
    "ERR_METADATA_RESERVED_FIELD",
    stamps
      .map((d) => {
        const filePath = (d.data as { filePath?: string } | undefined)?.filePath;
        return filePath ? `${describeModuleSource(graph, filePath)}: ${d.message}` : d.message;
      })
      .join("\n"),
    [
      ...stamps.map((d) => ({ ...staticDiagnosticToRuntime(d), code: `ERR_${d.code}` })),
      ...others.map(staticDiagnosticToRuntime),
    ],
  );
}

/** Refuses each stamp written on `declaration`, a declaration the kernel is
 *  about to make, naming it after `describe`. */
export function refuseWrittenStamps(declaration: unknown, describe: string): void {
  const fields = writtenNestedStamps(declaration);
  if (fields.length === 0) return;
  throw new RuntimeError(
    "ERR_METADATA_RESERVED_FIELD",
    fields
      .map((field) => `${describe}: ${metadataStampMessage(declaration as { kind?: unknown; metadata?: unknown }, field)}`)
      .join("\n"),
  );
}

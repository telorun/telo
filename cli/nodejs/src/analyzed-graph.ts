import {
  AnalysisRegistry,
  StaticAnalyzer,
  collectModuleDocuments,
  flattenForAnalyzer,
  DiagnosticSeverity,
  isModuleKind,
  type AnalysisDiagnostic,
  type LoadedGraph,
} from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import * as path from "node:path";
import { nodeHostVersions } from "@telorun/kernel";
import { cacheTargetFor, loadFreshGraph, openSession } from "./check-session.js";
import { resolveLocation, type Logger } from "./logger.js";
import { resolveManifestInput, type ManifestInput } from "./manifest-input.js";
import { outErrLine } from "./output.js";

/** A manifest's graph, loaded and analyzed with nothing booted. */
export interface AnalyzedGraph {
  /** What the command was handed, resolved — a packaged executable included. */
  input: ManifestInput;
  entryPath: string;
  graph: LoadedGraph;
  /** The flattened set the analysis ran over. */
  manifests: ResourceManifest[];
  /** The registry that analysis filled. */
  registry: AnalysisRegistry;
  /** The entry's module doc in that set. */
  root: ResourceManifest | undefined;
  /** The analysis's error diagnostics. */
  errors: AnalysisDiagnostic[];
}

/**
 * Load `manifest`'s graph through the check session and analyze it, as `telo
 * check` does. A graph that does not load — or a packaged executable that
 * cannot be unpacked — is refused here: its failures are printed on stderr,
 * `process.exitCode` is set, and the result is `undefined`.
 */
export async function loadAnalyzedGraph(manifest: string, log: Logger): Promise<AnalyzedGraph | undefined> {
  let input: ManifestInput;
  try {
    input = await resolveManifestInput(manifest);
  } catch (err) {
    outErrLine(`${log.err.error("error")}  ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return undefined;
  }
  const entryPath = input.entryPath;
  const target = cacheTargetFor(input);
  const session = openSession(target ? [target] : []);
  let graph: LoadedGraph;
  try {
    ({ graph } = await loadFreshGraph(entryPath, session, log));
  } catch (err) {
    // An entry that cannot be read at all, reported as `telo check` reports it.
    const sourceLine = (err as { sourceLine?: number }).sourceLine;
    const isUrl = entryPath.startsWith("http://") || entryPath.startsWith("https://");
    const at = isUrl ? entryPath : path.relative(process.cwd(), entryPath);
    outErrLine(
      `${at}${sourceLine !== undefined ? `:${sourceLine + 1}` : ""}  ${log.err.error("error")}  ` +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exitCode = 1;
    return undefined;
  }

  const loadFailures = [
    ...graph.errors.map((e) => e.error.message),
    ...graph.parseDiagnostics.map((d) => d.message),
  ];
  if (loadFailures.length > 0) {
    for (const message of loadFailures) outErrLine(`${log.err.error("error")}  ${message}`);
    process.exitCode = 1;
    return undefined;
  }

  const manifests = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  const errors = new StaticAnalyzer()
    .analyze(
      manifests,
      { moduleDocuments: collectModuleDocuments(graph), hostVersions: nodeHostVersions() },
      registry,
    )
    .filter((d) => d.severity === DiagnosticSeverity.Error);
  const root = manifests.find(
    (m) =>
      isModuleKind(m.kind) &&
      (m.metadata as { source?: string } | undefined)?.source === graph.entry.owner.source,
  );
  return { input, entryPath, graph, manifests, registry, root, errors };
}

/** Print the refusals that keep `subject` from yielding `product`, each where
 *  it is written, and set `process.exitCode`. */
export function printRefusals(
  analyzed: AnalyzedGraph,
  refusals: readonly AnalysisDiagnostic[],
  log: Logger,
  subject: string,
  product: string,
): void {
  for (const d of refusals) {
    const at = resolveLocation(analyzed.graph, d, analyzed.entryPath);
    outErrLine(
      `${at ? `${at}  ` : ""}${log.err.error("error")}  ${d.message}${d.code ? `  ${log.err.dim(String(d.code))}` : ""}`,
    );
  }
  outErrLine(
    `\n${refusals.length} error${refusals.length === 1 ? "" : "s"} — the ${subject} does not load, so it has no ${product}.`,
  );
  process.exitCode = 1;
}

import { edgesFrom } from "./flatten-for-analyzer.js";
import type { LoadedGraph } from "./loaded-types.js";
import { isLocalPathSource } from "./sources/local-path-ref.js";
import { isOciRef } from "./sources/oci-ref.js";

/**
 * Where a loaded module came from, which decides how its own findings are
 * reported to an application loading it:
 *
 * - `editable` — reached from the entry through filesystem-path imports alone,
 *   so its files are the author's to fix: reported at its own lines;
 * - `artifact` — reached through an `oci://` or `http(s)://` import anywhere on
 *   its authored import chain, or shipped inside an artifact: reported at the
 *   entry's import reaching it.
 *
 * Origin follows the import as WRITTEN (`ImportEdge.targetRef`), never the URL
 * that served it, so an artifact served as a cached file copy stays one.
 * Browser-safe.
 */
export type ModuleOrigin = "editable" | "artifact";

/**
 * The origin of every module the entry reaches, keyed by the module's owner
 * source — the entry included, as `editable`. The walk follows the graph's
 * import edges, which version reconciliation repointed at their winner, so a
 * replaced version is absent.
 */
export function moduleOrigins(graph: LoadedGraph): Map<string, ModuleOrigin> {
  const origins = new Map<string, ModuleOrigin>([[graph.rootSource, "editable"]]);
  const editable: string[] = [graph.rootSource];
  for (let source = editable.shift(); source !== undefined; source = editable.shift()) {
    for (const edge of edgesFrom(graph, source)) {
      const target = graph.modules.get(edge.targetSource);
      if (!target || origins.has(edge.targetSource)) continue;
      // A path import inside an artifact names a module shipped in it.
      if (!isLocalPathSource(edge.targetRef) || isOciRef(target.owner.requestedUrl)) continue;
      origins.set(edge.targetSource, "editable");
      editable.push(edge.targetSource);
    }
  }
  for (const source of reachedModuleSources(graph, graph.rootSource)) {
    if (!origins.has(source)) origins.set(source, "artifact");
  }
  return origins;
}

/** The owner source of every module reached from `from` through import edges,
 *  `from` included. */
export function reachedModuleSources(graph: LoadedGraph, from: string): Set<string> {
  const reached = new Set<string>([from]);
  const queue = [from];
  for (let source = queue.shift(); source !== undefined; source = queue.shift()) {
    for (const edge of edgesFrom(graph, source)) {
      if (reached.has(edge.targetSource) || !graph.modules.has(edge.targetSource)) continue;
      reached.add(edge.targetSource);
      queue.push(edge.targetSource);
    }
  }
  return reached;
}

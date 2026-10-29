import type { LoadedGraph, LoadedModule } from "./loaded-types.js";
import { splitIntegrity } from "./sources/integrity.js";
import { isOciRef, parseOciRef, type ParsedOciRef } from "./sources/oci-ref.js";

/** Where a module shipped inside another module's artifact came from. */
export interface NestedModuleOrigin {
  /** The artifact's root module, as this load reached it. */
  root: LoadedModule;
  /** The ref the root was requested by, pin removed: the parent as written
   *  (`oci://ghcr.io/telorun/authoring-agent@0.29.3`), never its digest. */
  parent: string;
  /** The nested module's path inside the artifact. */
  path: string;
}

function nestedRefOf(requestedUrl: string): ParsedOciRef | undefined {
  if (!isOciRef(requestedUrl)) return undefined;
  try {
    const parsed = parseOciRef(requestedUrl);
    return parsed.path === undefined ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/**
 * The origin of the module whose owner file resolved from `source`, when it is
 * a nested module (requested by `oci://<host>/<repo>@sha256:<digest>/<path>`);
 * `undefined` for any other module.
 *
 * The root is found through the import edges: a nested identity is only ever
 * built while resolving a relative import inside its artifact, so following
 * the importers of nested modules back reaches the module the artifact was
 * loaded as.
 */
export function nestedModuleOrigin(
  graph: Pick<LoadedGraph, "modules" | "importEdges">,
  source: string,
): NestedModuleOrigin | undefined {
  const moduleOfFile = new Map<string, LoadedModule>();
  for (const mod of graph.modules.values()) {
    for (const file of [mod.owner, ...mod.partials]) moduleOfFile.set(file.source, mod);
  }
  const start = moduleOfFile.get(source);
  const nested = start && nestedRefOf(start.owner.requestedUrl);
  if (!start || !nested) return undefined;

  const importers = new Map<string, string[]>();
  for (const [from, edges] of graph.importEdges) {
    for (const edge of edges.values()) {
      const list = importers.get(edge.targetSource) ?? [];
      list.push(from);
      importers.set(edge.targetSource, list);
    }
  }

  const visited = new Set<string>();
  const queue: LoadedModule[] = [start];
  for (let current = queue.shift(); current; current = queue.shift()) {
    if (visited.has(current.owner.source)) continue;
    visited.add(current.owner.source);
    for (const from of importers.get(current.owner.source) ?? []) {
      const importer = moduleOfFile.get(from);
      if (!importer || !isOciRef(importer.owner.requestedUrl)) continue;
      const parsed = parseOciRef(importer.owner.requestedUrl);
      if (parsed.host !== nested.host || parsed.repo !== nested.repo) continue;
      if (parsed.path !== undefined) {
        queue.push(importer);
        continue;
      }
      return {
        root: importer,
        parent: splitIntegrity(importer.owner.requestedUrl).base,
        path: nested.path!,
      };
    }
  }
  return undefined;
}

/** `source` as a reader should see it: a nested module named by its parent as
 *  written beside its path, so no one has to look up a digest; anything else
 *  unchanged. */
export function describeModuleSource(
  graph: Pick<LoadedGraph, "modules" | "importEdges">,
  source: string,
): string {
  const origin = nestedModuleOrigin(graph, source);
  return origin ? `${origin.parent}, nested module '${origin.path}'` : source;
}

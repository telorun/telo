import type { ResourceManifest } from "@telorun/sdk";
import type { LoadedFile, LoadedGraph, LoadedModule } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";

/** The import-boundary forwarding rule, shared by `flattenForAnalyzer` (the
 *  CLI / kernel loader path) and the telo-editor's workspace projection so the
 *  two cannot drift. Given one module's stamped manifests and whether that
 *  module is the analysis entry (root), returns the manifests that cross into
 *  the consumer's flat analysis list:
 *
 *  - **Root module** — every manifest is local; returned unchanged. The root's
 *    internals (CEL / schema / refs) are validated in full.
 *  - **Imported module** — only `Telo.Definition` / `Telo.Abstract` /
 *    `Telo.Import` docs cross unconditionally, plus the instances named in the
 *    module's `exports.resources` (stamped `metadata.forwardedExport: true`).
 *    The module doc and internal (unexported) instances are dropped — they
 *    belong to that module's own analysis pass.
 *
 *  `forwardedExport` marks an instance as a cross-module resolution TARGET only
 *  (keyed by `metadata.module`), so `resolveRefSentinels` files it under
 *  `byModuleName` and `!ref Alias.name` resolves, while `validate-references` /
 *  the per-resource validation loop never re-walk or re-validate it against the
 *  consumer's scope. A consumer that instead emits every module doc as a peer
 *  local manifest silently breaks both. */
export function selectModuleManifestsForAnalysis(
  moduleManifests: ResourceManifest[],
  isRoot: boolean,
): ResourceManifest[] {
  if (isRoot) return moduleManifests;

  const libDoc = moduleManifests.find((m) => isModuleKind(m.kind));
  const exportedResources = new Set<string>(
    (libDoc as { exports?: { resources?: string[] } } | undefined)?.exports?.resources ?? [],
  );

  const out: ResourceManifest[] = [];
  for (const m of moduleManifests) {
    if (m.kind === "Telo.Definition" || m.kind === "Telo.Abstract" || m.kind === "Telo.Import") {
      out.push(m);
    } else if (
      !isModuleKind(m.kind) &&
      typeof m.metadata?.name === "string" &&
      exportedResources.has(m.metadata.name as string)
    ) {
      out.push({
        ...m,
        metadata: { ...m.metadata, forwardedExport: true } as ResourceManifest["metadata"],
      });
    }
  }
  return out;
}

/** Produce the flat manifest list `analyze()` consumes today.
 *
 *  Combines the entry module's manifests with `Telo.Definition`,
 *  `Telo.Abstract`, and `Telo.Import` docs forwarded from imported libraries
 *  (plus their `exports.resources` instances) via `selectModuleManifestsForAnalysis`.
 *  Stamps three flavours of metadata along the way:
 *
 *  - `metadata.source` and `metadata.sourceLine` — already on each manifest
 *    from `parseLoadedFile`, copied here unchanged.
 *  - `metadata.module` — the owning module's `Telo.Application` /
 *    `Telo.Library` `metadata.name`, applied to non-module manifests that
 *    don't already carry one.
 *  - `metadata.resolvedModuleName` / `metadata.resolvedNamespace` — for every
 *    `Telo.Import` manifest, looked up via `graph.importEdges` to find the
 *    target module's own `Telo.Library` identity. Without this, the
 *    analyzer's alias resolver and `validate-extends` fall back to
 *    path-derived identity and produce spurious diagnostics.
 *
 *  Position metadata (`positionIndex`) is NOT stamped on manifests —
 *  callers look it up via `findPositions(graph, ...)` on the LoadedGraph. */
export function flattenForAnalyzer(graph: LoadedGraph): ResourceManifest[] {
  const result: ResourceManifest[] = [];

  result.push(...selectModuleManifestsForAnalysis(collectModuleManifests(graph.entry), true));

  const seen = new Set<string>([graph.rootSource]);
  const queue: string[] = [graph.rootSource];

  while (queue.length > 0) {
    const fromSource = queue.shift()!;
    const edges = graph.importEdges.get(fromSource);
    if (!edges) continue;

    for (const edge of edges.values()) {
      if (seen.has(edge.targetSource)) continue;
      seen.add(edge.targetSource);
      queue.push(edge.targetSource);

      const targetModule = graph.modules.get(edge.targetSource);
      if (!targetModule) continue;

      result.push(...selectModuleManifestsForAnalysis(collectModuleManifests(targetModule), false));
    }
  }

  // Stamp resolved import identity on every Telo.Import in the result by
  // reading the edge's pre-resolved name/namespace — no re-derivation from
  // manifest metadata. The edge is keyed by (owner-file, alias) which is
  // exactly the (metadata.source, metadata.name) pair on each Telo.Import.
  for (let i = 0; i < result.length; i++) {
    const m = result[i];
    if (m.kind !== "Telo.Import") continue;
    const owner = (m.metadata as { source?: string } | undefined)?.source;
    const alias = m.metadata?.name as string | undefined;
    if (!owner || !alias) continue;
    const edge = graph.importEdges.get(owner)?.get(alias);
    if (!edge?.targetModuleName) continue;

    const newMetadata: Record<string, unknown> = {
      ...m.metadata,
      resolvedModuleName: edge.targetModuleName,
      resolvedNamespace: edge.targetNamespace,
    };
    result[i] = { ...m, metadata: newMetadata as ResourceManifest["metadata"] };
  }

  return result;
}

/** Project a LoadedModule (owner + partials) to a flat ResourceManifest[]
 *  with `metadata.module` stamped on non-module docs. The kernel's runtime
 *  entry load uses this to convert a `Loader.loadModule` result into the
 *  classic ResourceManifest[] shape it iterates over. Imports are not
 *  followed — the kernel's import-controller loads each import's module
 *  separately at runtime. */
export function flattenLoadedModule(mod: LoadedModule): ResourceManifest[] {
  return collectModuleManifests(mod);
}

function collectModuleManifests(mod: LoadedModule): ResourceManifest[] {
  const owner = stampFile(mod.owner, ownerModuleName(mod.owner));
  const partials: ResourceManifest[] = [];
  for (const p of mod.partials) {
    partials.push(...stampFile(p, ownerModuleName(mod.owner)));
  }
  return [...owner, ...partials];
}

function ownerModuleName(file: LoadedFile): string | undefined {
  for (const m of file.manifests) {
    if (m && isModuleKind(m.kind)) {
      const name = m.metadata?.name;
      if (typeof name === "string") return name;
    }
  }
  return undefined;
}

function stampFile(
  file: LoadedFile,
  ownerModule: string | undefined,
): ResourceManifest[] {
  const out: ResourceManifest[] = [];
  for (let i = 0; i < file.manifests.length; i++) {
    const m = file.manifests[i];
    if (m === null || m === undefined) continue;
    const { sourceLine } = file.positions[i];

    const metadata: Record<string, unknown> = {
      ...m.metadata,
      source: file.source,
      sourceLine,
    };
    if (ownerModule && !isModuleKind(m.kind) && !metadata.module) {
      metadata.module = ownerModule;
    }

    out.push({ ...m, metadata: metadata as ResourceManifest["metadata"] });
  }
  return out;
}

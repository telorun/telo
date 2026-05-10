import type { LoadedGraph, PositionIndex } from "@telorun/analyzer";

/** Diagnostic location lookup: which file owns the diagnostic's resource,
 *  and what positions does that file's parse expose. Encapsulates the
 *  routing both the editor and the vscode/CLI hosts previously wrote
 *  inline against per-manifest metadata fields.
 *
 *  Resolution order:
 *    1. `data.resource.{kind,name}` → search every LoadedFile in the graph
 *       for the doc with matching kind+name. Returns that file's source +
 *       its positions for the matching doc index.
 *    2. `data.filePath` → match the owning LoadedFile by canonical source.
 *
 *  Returns `undefined` if the diagnostic carries no usable identity. */
export function findPositions(
  graph: LoadedGraph,
  diagnosticData: unknown,
):
  | { file: string; positionIndex?: PositionIndex; sourceLine?: number }
  | undefined {
  const data = diagnosticData as
    | { resource?: { kind?: string; name?: string }; filePath?: string }
    | undefined;
  if (!data) return undefined;

  if (data.resource?.kind && data.resource.name) {
    const result = findByResource(graph, data.resource.kind, data.resource.name);
    if (result) return result;
  }

  if (data.filePath) {
    const result = findByFile(graph, data.filePath);
    if (result) return result;
  }

  return undefined;
}

function findByResource(
  graph: LoadedGraph,
  kind: string,
  name: string,
): { file: string; positionIndex?: PositionIndex; sourceLine?: number } | undefined {
  for (const mod of graph.modules.values()) {
    for (const file of [mod.owner, ...mod.partials]) {
      for (let i = 0; i < file.manifests.length; i++) {
        const m = file.manifests[i];
        if (!m) continue;
        if (m.kind !== kind) continue;
        if (m.metadata?.name !== name) continue;
        const pos = file.positions[i];
        return {
          file: file.source,
          positionIndex: pos?.positionIndex,
          sourceLine: pos?.sourceLine,
        };
      }
    }
  }
  return undefined;
}

function findByFile(
  graph: LoadedGraph,
  filePath: string,
): { file: string; positionIndex?: PositionIndex; sourceLine?: number } | undefined {
  for (const mod of graph.modules.values()) {
    for (const file of [mod.owner, ...mod.partials]) {
      if (file.source === filePath) {
        const pos = file.positions[0];
        return {
          file: file.source,
          positionIndex: pos?.positionIndex,
          sourceLine: pos?.sourceLine,
        };
      }
    }
  }
  return undefined;
}

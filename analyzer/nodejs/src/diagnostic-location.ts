import { expansionTagLabel } from "@telorun/templating";
import type { LoadedGraph } from "./loaded-types.js";
import type { AnalysisDiagnostic, PositionIndex, Range } from "./types.js";

/** What a diagnostic's owning file exposes for locating it. */
export interface DiagnosticPositions {
  file: string;
  positionIndex?: PositionIndex;
  sourceLine?: number;
}

/** Which file owns a diagnostic, and what positions that file's parse exposes.
 *
 *  Resolution order:
 *    1. `data.resource.{kind,name}` → the doc with matching kind+name, in
 *       the file `data.filePath` names when it names one — two modules may
 *       declare the same name — otherwise in any LoadedFile of the graph.
 *       Returns that file's source + its positions for the matching doc index.
 *    2. `data.filePath` → match the owning LoadedFile by canonical source.
 *
 *  Returns `undefined` if the diagnostic carries no usable identity. */
export function findPositions(
  graph: LoadedGraph,
  diagnosticData: unknown,
): DiagnosticPositions | undefined {
  const data = diagnosticData as
    | { resource?: { kind?: string; name?: string }; filePath?: string }
    | undefined;
  if (!data) return undefined;

  if (data.resource?.kind && data.resource.name) {
    const result =
      (data.filePath !== undefined
        ? findByResource(graph, data.resource.kind, data.resource.name, data.filePath)
        : undefined) ?? findByResource(graph, data.resource.kind, data.resource.name);
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
  inFile?: string,
): DiagnosticPositions | undefined {
  for (const mod of graph.modules.values()) {
    for (const file of [mod.owner, ...mod.partials]) {
      if (inFile !== undefined && file.source !== inFile) continue;
      for (let i = 0; i < file.manifests.length; i++) {
        const m = file.manifests[i];
        if (!m) continue;
        // A whole document behind an expansion tag is reported under its tag (`!if`).
        if ((m.kind ?? expansionTagLabel(m)) !== kind) continue;
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

function findByFile(graph: LoadedGraph, filePath: string): DiagnosticPositions | undefined {
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

const ZERO_RANGE: Range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

/** The range a diagnostic is shown at:
 *    1. `d.range` if present.
 *    2. `positionIndex.get(d.data.path)` for a direct hit (covers diagnostics
 *       that target an existing value, e.g. wrong type, enum violation).
 *    3. If the leaf is missing (e.g. "missing required property" — `.type`
 *       isn't in the YAML yet), walk one segment up at a time and squiggle
 *       just the parent's key identifier (`@key:<parent>`), not the parent's
 *       full value block. Keeps the squiggle scoped to the incomplete entry
 *       instead of spreading across every line of the surrounding map.
 *    4. Whole-line span at `sourceLine` when known.
 *    5. `(0,0)-(0,0)` as a last resort. Never undefined. */
export function resolveRange(
  d: AnalysisDiagnostic,
  positions: { positionIndex?: PositionIndex; sourceLine?: number },
): Range {
  if (d.range) return d.range;

  const fieldPath = (d.data as { path?: string } | undefined)?.path;
  if (fieldPath !== undefined && positions.positionIndex) {
    const direct = positions.positionIndex.get(fieldPath);
    if (direct) return direct;
    for (const parent of parentPaths(fieldPath).slice(1)) {
      const keyRange = positions.positionIndex.get(`@key:${parent}`);
      if (keyRange) return keyRange;
      const valueRange = positions.positionIndex.get(parent);
      if (valueRange) return valueRange;
    }
  }

  if (positions.sourceLine !== undefined) {
    return {
      start: { line: positions.sourceLine, character: 0 },
      end: { line: positions.sourceLine, character: Number.MAX_SAFE_INTEGER },
    };
  }

  return ZERO_RANGE;
}

/** Where a diagnostic is, as every host reports it: its owning file (absent
 *  when only its own range placed it) and its range. Undefined when nothing
 *  locates it — a pointer to line 1 would send the reader somewhere the error
 *  is not. */
export function locateDiagnostic(
  graph: LoadedGraph,
  d: AnalysisDiagnostic,
): { file?: string; range: Range } | undefined {
  const located = findPositions(graph, d.data);
  if (!located && !d.range) return undefined;
  return {
    ...(located ? { file: located.file } : {}),
    range: resolveRange(d, {
      positionIndex: located?.positionIndex,
      sourceLine: located?.sourceLine,
    }),
  };
}

/** Yield `path`, then progressively shorter parents formed by stripping
 *  trailing dotted segments and array index suffixes. For
 *  `"secrets.openaiApiKey.type"` → `["secrets.openaiApiKey.type",
 *  "secrets.openaiApiKey", "secrets"]`. For `"routes[0].handler"` →
 *  `["routes[0].handler", "routes[0]", "routes"]`. */
function parentPaths(path: string): string[] {
  const out: string[] = [];
  let cur = path;
  while (cur.length > 0) {
    out.push(cur);
    const lastDot = cur.lastIndexOf(".");
    const lastBracket = cur.lastIndexOf("[");
    const cut = Math.max(lastDot, lastBracket);
    if (cut <= 0) break;
    cur = cur.slice(0, cut);
  }
  return out;
}

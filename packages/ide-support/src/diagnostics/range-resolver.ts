import type { AnalysisDiagnostic, Range } from "@telorun/analyzer";
import type { DiagnosticContext } from "../types.js";

const ZERO_RANGE: Range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

/** Falls back through the chain from the VS Code extension's inline resolver
 *  (ide/vscode/src/extension.ts:203-216 before this package existed):
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
export function resolveRange(d: AnalysisDiagnostic, ctx: DiagnosticContext): Range {
  if (d.range) return d.range;

  const fieldPath = (d.data as { path?: string } | undefined)?.path;
  if (fieldPath !== undefined && ctx.positionIndex) {
    const direct = ctx.positionIndex.get(fieldPath);
    if (direct) return direct;
    for (const parent of parentPaths(fieldPath).slice(1)) {
      const keyRange = ctx.positionIndex.get(`@key:${parent}`);
      if (keyRange) return keyRange;
      const valueRange = ctx.positionIndex.get(parent);
      if (valueRange) return valueRange;
    }
  }

  if (ctx.sourceLine !== undefined) {
    return {
      start: { line: ctx.sourceLine, character: 0 },
      end: { line: ctx.sourceLine, character: Number.MAX_SAFE_INTEGER },
    };
  }

  return ZERO_RANGE;
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

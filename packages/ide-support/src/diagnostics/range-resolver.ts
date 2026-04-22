import type { AnalysisDiagnostic, Range } from "@telorun/analyzer";
import type { DiagnosticContext } from "../types.js";

const ZERO_RANGE: Range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

/** Falls back through the chain from the VS Code extension's inline resolver
 *  (ide/vscode/src/extension.ts:203-216 before this package existed):
 *    1. `d.range` if present.
 *    2. `positionIndex.get(d.data.path)` when both are available.
 *    3. Whole-line span at `sourceLine` when known.
 *    4. `(0,0)-(0,0)` as a last resort. Never undefined. */
export function resolveRange(d: AnalysisDiagnostic, ctx: DiagnosticContext): Range {
  if (d.range) return d.range;

  const fieldPath = (d.data as { path?: string } | undefined)?.path;
  if (fieldPath !== undefined && ctx.positionIndex) {
    const fieldRange = ctx.positionIndex.get(fieldPath);
    if (fieldRange) return fieldRange;
  }

  if (ctx.sourceLine !== undefined) {
    return {
      start: { line: ctx.sourceLine, character: 0 },
      end: { line: ctx.sourceLine, character: Number.MAX_SAFE_INTEGER },
    };
  }

  return ZERO_RANGE;
}

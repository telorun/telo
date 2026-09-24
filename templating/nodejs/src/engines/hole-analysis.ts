import type { ASTNode } from "@marcbachmann/cel-js";
import type { CompiledValue } from "@telorun/sdk";
import { compileExpression } from "../cel/compile.js";
import {
  readInterpolationHoles,
  type InterpolationHole,
} from "../cel/interpolation-holes.js";
import type {
  AnalyzeEnv,
  AnalyzeResult,
  CallSite,
  CompileEnv,
  DiagnosticFix,
  EngineDiagnostic,
  ExpressionRegion,
} from "../engine.js";
import { analyzeCelWithTree } from "./cel.js";

/** The holes of a scalar a hole-bearing tag compiles, or a thrown error naming
 *  where the reading failed — a tag's scalar that cannot be read is not a value. */
export function requireHoles(tag: string, source: string): readonly InterpolationHole[] {
  const reading = readInterpolationHoles(source);
  if (!reading.ok) throw new Error(`!${tag}: ${reading.message}`);
  return reading.holes;
}

/** Every hole compiled as its own CEL expression, with the roots, module calls
 *  and volatility of all of them carried together. */
export function compileHoles(
  holes: readonly InterpolationHole[],
  env: CompileEnv,
): {
  readonly compiled: readonly CompiledValue[];
  readonly refs: readonly string[];
  readonly calls: readonly string[];
  readonly volatile: boolean;
} {
  const compiled = holes.map((h) => compileExpression(h.expr, env.celEnv, env.moduleNames));
  const refs = new Set<string>();
  const calls = new Set<string>();
  let volatile = false;
  for (const c of compiled) {
    for (const r of c.refs ?? []) refs.add(r);
    for (const q of c.calls ?? []) calls.add(q);
    if (c.volatile) volatile = true;
  }
  return { compiled, refs: [...refs], calls: [...calls], volatile };
}

/** Analyze each hole with the shared CEL analysis, so diagnostics read exactly
 *  as they do under `!cel`; a fix computed against one hole's expression is
 *  re-anchored onto the whole scalar, and call offsets onto the scalar too.
 *  `perHole` adds a tag's own verdict on a hole that analyzed clean. */
export function analyzeHoles(
  source: string,
  env: AnalyzeEnv,
  perHole?: (
    hole: InterpolationHole,
    result: AnalyzeResult,
    ast: ASTNode | undefined,
  ) => readonly EngineDiagnostic[],
): AnalyzeResult {
  const reading = readInterpolationHoles(source);
  if (!reading.ok) {
    return { diagnostics: [{ code: "CEL_SYNTAX_ERROR", message: reading.message }], calls: [] };
  }
  const diagnostics: EngineDiagnostic[] = [];
  const calls: CallSite[] = [];
  for (const hole of reading.holes) {
    const { result, ast } = analyzeCelWithTree(hole.expr, env);
    for (const d of result.diagnostics) {
      diagnostics.push(d.fix ? { ...d, fix: reanchor(source, hole, d.fix) } : d);
    }
    for (const c of result.calls) {
      calls.push({ ...c, start: hole.exprStart + c.start, end: hole.exprStart + c.end });
    }
    if (perHole && result.diagnostics.length === 0) diagnostics.push(...perHole(hole, result, ast));
  }
  return { diagnostics, calls };
}

/** The CEL expressions of a hole-bearing scalar, by offset. */
export function holeRegions(source: string): readonly ExpressionRegion[] {
  const reading = readInterpolationHoles(source);
  if (!reading.ok) return [];
  return reading.holes.map((h) => ({ start: h.exprStart, end: h.exprStart + h.expr.length }));
}

function reanchor(source: string, hole: InterpolationHole, fix: DiagnosticFix): DiagnosticFix {
  return {
    replacement:
      source.slice(0, hole.exprStart) +
      fix.replacement +
      source.slice(hole.exprStart + hole.expr.length),
  };
}

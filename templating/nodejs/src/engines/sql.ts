import { isParameterizedSql, type CompiledValue, type ParameterizedSql } from "@telorun/sdk";
import { analyzeCelExpression } from "./cel.js";
import { compileString, toParameterized, TEMPLATE_REGEX } from "../cel/compile.js";
import type {
  CallSite,
  DiagnosticFix,
  EngineDiagnostic,
  TemplatingEngine,
} from "../engine.js";

export { isParameterizedSql, type ParameterizedSql };

/** The `!sql` engine. Treats the tagged scalar as a SQL string with `${{ }}`
 *  interpolations whose values are *bound*, not spliced. Unlike `!cel` (one bare
 *  expression) it keeps the literal text and each interpolation separate: at
 *  runtime `call()` returns a {@link ParameterizedSql} the consumer turns into a
 *  parameterized query. Generic expansion passes that object through untouched
 *  (it is the `call()` result), so it survives the step-level input expansion. */
export const sqlEngine: TemplatingEngine = {
  name: "sql",
  language: "sql",

  compile(source, env) {
    const inner = compileString(source, env.celEnv);
    return {
      __compiled: true,
      source,
      // The AST-derived root identifiers of every interpolation, carried through
      // rather than dropped. `compileString` has already computed them one line
      // above, and a consumer that asks a compiled value what it READS —
      // a template body deciding which nodes survive its `init()` — otherwise
      // falls back to scanning the source text, which cannot tell an identifier
      // from a word inside a SQL string literal.
      refs: typeof inner === "string" ? [] : (inner as CompiledValue).refs,
      call: (ctx: Record<string, unknown>): ParameterizedSql => {
        const { fragments, values } = toParameterized(inner, ctx);
        return { __teloParameterized: true, fragments, values };
      },
    } satisfies CompiledValue;
  },

  analyze(source, env) {
    // Each `${{ }}` interpolation is its own CEL expression; reuse the shared
    // per-expression analyzer so diagnostics match the `!cel` engine exactly.
    // Each interpolation's offset is kept so a fix computed against the bare
    // expression is re-anchored to the whole SQL scalar — the only thing that
    // ever made `!sql` fix-less was dropping it here.
    const diagnostics: EngineDiagnostic[] = [];
    const calls: CallSite[] = [];
    for (const { expr, start } of expressionsOf(source)) {
      const result = analyzeCelExpression(expr, env);
      for (const d of result.diagnostics) {
        diagnostics.push(d.fix ? { ...d, fix: reanchor(source, expr, start, d.fix) } : d);
      }
      for (const c of result.calls) {
        calls.push({ ...c, start: start + c.start, end: start + c.end });
      }
    }
    // No `type`: a SQL template is a string built from many expressions, so
    // there is no single checked type to report.
    return { diagnostics, calls };
  },
};

/** Re-anchor a fix computed against one interpolation onto the full source. */
function reanchor(source: string, expr: string, start: number, fix: DiagnosticFix): DiagnosticFix {
  return {
    replacement: source.slice(0, start) + fix.replacement + source.slice(start + expr.length),
  };
}

/** Each `${{ expr }}` body in a `!sql` template, with the body's offset in the
 *  source. The offset is derived from the opening delimiter and the leading
 *  whitespace the capture group already trims, never by searching for the
 *  body text — which a body appearing twice would defeat. */
function expressionsOf(source: string): { expr: string; start: number }[] {
  const out: { expr: string; start: number }[] = [];
  for (const m of source.matchAll(TEMPLATE_REGEX)) {
    const lead = /^\s*/.exec(m[0]!.slice(OPEN.length))![0]!.length;
    out.push({ expr: m[1]!, start: m.index! + OPEN.length + lead });
  }
  return out;
}

const OPEN = "${{";

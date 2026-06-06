import { isParameterizedSql, type CompiledValue, type ParameterizedSql } from "@telorun/sdk";
import { analyzeCelExpression } from "./cel.js";
import { compileString, toParameterized, TEMPLATE_REGEX } from "../cel/compile.js";
import type { TemplatingEngine } from "../engine.js";

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
      call: (ctx: Record<string, unknown>): ParameterizedSql => {
        const { fragments, values } = toParameterized(inner, ctx);
        return { __teloParameterized: true, fragments, values };
      },
    } satisfies CompiledValue;
  },

  analyze(source, env) {
    // Each `${{ }}` interpolation is its own CEL expression; reuse the shared
    // per-expression analyzer so diagnostics match the `!cel` engine exactly.
    return expressionsOf(source).flatMap((expr) => analyzeCelExpression(expr, env));
  },
};

/** Extract each `${{ expr }}` body from a `!sql` template source. */
function expressionsOf(source: string): string[] {
  const exprs: string[] = [];
  for (const m of source.matchAll(TEMPLATE_REGEX)) {
    exprs.push(m[1]!.trim());
  }
  return exprs;
}

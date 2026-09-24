import { isParameterizedSql, type CompiledValue, type ParameterizedSql } from "@telorun/sdk";
import { literalFragments } from "../cel/interpolation-holes.js";
import type { TemplatingEngine } from "../engine.js";
import { analyzeHoles, compileHoles, holeRegions, requireHoles } from "./hole-analysis.js";

export { isParameterizedSql, type ParameterizedSql };

/** The `!sql` engine. Treats the tagged scalar as a SQL string with `${{ }}`
 *  holes whose values are *bound*, not spliced. Unlike `!cel` (one bare
 *  expression) it keeps the literal text and each hole separate: at runtime
 *  `call()` returns a {@link ParameterizedSql} the consumer turns into a
 *  parameterized query. Generic expansion passes that object through untouched
 *  (it is the `call()` result), so it survives the step-level input expansion. */
export const sqlEngine: TemplatingEngine = {
  name: "sql",
  language: "sql",

  compile(source, env) {
    const holes = requireHoles("sql", source);
    const fragments = literalFragments(source, holes);
    const { compiled, refs, calls, volatile } = compileHoles(holes, env);
    return {
      __compiled: true,
      source,
      // Carried for the reason `!cel` carries them: a consumer asking what an
      // expression READS or CALLS cannot re-derive it from SQL text, which
      // cannot tell an identifier from a word inside a string literal.
      refs,
      calls,
      ...(volatile ? { volatile: true as const } : {}),
      call: (ctx: Record<string, unknown>): ParameterizedSql => ({
        __teloParameterized: true,
        fragments: fragments.slice(),
        values: compiled.map((c) => c.call(ctx)),
      }),
    } satisfies CompiledValue;
  },

  analyze(source, env) {
    // No `type`: a SQL template is a query built from many expressions, so
    // there is no single checked type to report.
    return analyzeHoles(source, env);
  },

  expressionRegions(source) {
    return holeRegions(source);
  },
};

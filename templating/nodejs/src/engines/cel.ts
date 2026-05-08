import { extractAccessChains, validateChainAgainstSchema } from "../cel/analyze.js";
import { compileExpression } from "../cel/compile.js";
import type { EngineDiagnostic, TemplatingEngine } from "../engine.js";

/** The `!cel` engine. Treats the entire tagged scalar as a single CEL
 *  expression — no `${{ }}` wrapping. Analysis runs the same chain validator
 *  as the untagged path: parse → extract member-access chains → validate each
 *  chain against the effective context schema. */
export const celEngine: TemplatingEngine = {
  name: "cel",
  language: "cel",

  compile(source, env) {
    return compileExpression(source, env.celEnv);
  },

  analyze(source, env) {
    const out: EngineDiagnostic[] = [];

    let parsed: ReturnType<typeof env.celEnv.parse>;
    try {
      parsed = env.celEnv.parse(source);
    } catch (e) {
      out.push({
        code: "CEL_SYNTAX_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
      return out;
    }

    if (!env.contextSchema) return out;

    const chains = extractAccessChains(parsed.ast);
    for (const chain of chains) {
      const err = validateChainAgainstSchema(chain, env.contextSchema as Record<string, any>);
      if (err) out.push({ code: "CEL_UNKNOWN_FIELD", message: err });
    }
    return out;
  },
};

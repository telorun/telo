import {
  extractAccessChains,
  findNullableAccessIssues,
  validateChainAgainstSchema,
} from "../cel/analyze.js";
import { compileExpression } from "../cel/compile.js";
import { auditCalls, explainUnresolved } from "../cel/diagnose.js";
import type { AnalyzeEnv, AnalyzeResult, EngineDiagnostic, TemplatingEngine } from "../engine.js";

/** Statically analyze one CEL expression against the effective context schema:
 *  parse → classify every call → type-check → validate member-access chains →
 *  flag nullable access. Single source of truth shared by the `!cel` engine
 *  (one expression) and the `!sql` engine (one per `${{ }}` interpolation), so
 *  diagnostic wording can't drift between them.
 *
 *  The type-check lives here, not in the analyzer, so one expression produces
 *  one verdict against one environment. Splitting them let an opaque
 *  "no matching overload" survive next to the diagnostic that actually
 *  explained it, and left `${{ }}` interpolations chain-validated but never
 *  type-checked at all. */
export function analyzeCelExpression(source: string, env: AnalyzeEnv): AnalyzeResult {
  const out: EngineDiagnostic[] = [];

  let parsed: ReturnType<typeof env.celEnv.parse>;
  try {
    parsed = env.celEnv.parse(source);
  } catch (e) {
    return {
      diagnostics: [{ code: "CEL_SYNTAX_ERROR", message: e instanceof Error ? e.message : String(e) }],
      calls: [],
    };
  }

  const audit = auditCalls(source, parsed.ast, env.celEnv);

  let type: string | undefined;
  let checkError: string | undefined;
  try {
    const result = env.celEnv.check(source);
    if (result.valid) type = result.type;
    else if (result.error) {
      checkError = String((result.error as { message?: string }).message ?? result.error)
        .split("\n")[0]!
        .trim();
    }
  } catch (e) {
    // The checker is now the ONLY type verdict for every CEL expression, so a
    // crash here silently retires static typing for that expression. Report it
    // instead: degrading is acceptable, degrading invisibly is not.
    return {
      diagnostics: [
        {
          code: "CEL_TYPE_ERROR",
          message: `the CEL type-checker failed on this expression: ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      ],
      calls: audit.calls,
    };
  }

  // The audit only ever EXPLAINS a rejection — it never overrules acceptance.
  // Its classification is decided from the registry, so a call cel-js accepts
  // but the registry cannot account for (a macro the parser expands and the
  // registry never sees, which a cel-js upgrade can introduce at any time) must
  // not become a hard error on valid CEL. Reporting nothing where cel-js is
  // happy makes an unknown future macro a silent no-op rather than a manifest
  // this analyzer refuses and the kernel would run fine.
  if (checkError !== undefined) {
    // `check()` stops at its first problem; the audit enumerates every bad call,
    // which is the whole reason it exists as more than a message rewriter.
    out.push(...audit.diagnostics);
    if (audit.diagnostics.length === 0) {
      out.push({
        code: "CEL_TYPE_ERROR",
        message: checkError + explainUnresolved(audit.unresolved, env.celEnv) + DYN_HINT(checkError),
      });
    }
  }

  if (env.contextSchema) {
    const contextSchema = env.contextSchema as Record<string, any>;
    for (const chain of extractAccessChains(parsed.ast)) {
      const err = validateChainAgainstSchema(chain, contextSchema);
      if (err) out.push({ code: "CEL_UNKNOWN_FIELD", message: err });
    }

    for (const issue of findNullableAccessIssues(parsed.ast, contextSchema)) {
      // Index access (member "[index]") attaches without a dot; a named field
      // attaches with one — so the suggested CEL stays valid either way.
      const access = issue.member === "[index]" ? issue.member : `.${issue.member}`;
      out.push({
        code: "CEL_NULLABLE_ACCESS",
        message: `'${issue.path}' may be null — guard it (e.g. '${issue.path} != null && …' or '${issue.path} == null ? … : ${issue.path}${access}') before accessing '${access}'`,
      });
    }
  }

  return { diagnostics: out, calls: audit.calls, ...(type === undefined ? {} : { type }) };
}

/** `dyn` in a checker message means an operand whose type is unknown here —
 *  almost always a step result whose invoked resource declares no
 *  `outputType:`. Without this, the reader takes `dyn` for a cast problem. */
const DYN_HINT = (message: string): string =>
  // Word-bounded: "dynamic" appears in unrelated checker messages, and the
  // hint is wrong for those.
  /\bdyn\b/.test(message)
    ? " (`dyn` is a value with no static type here — declare `outputType:` on the resource producing it, or convert at the call site.)"
    : "";

/** The `!cel` engine. Treats the entire tagged scalar as a single CEL
 *  expression — no `${{ }}` wrapping. */
export const celEngine: TemplatingEngine = {
  name: "cel",
  language: "cel",

  compile(source, env) {
    return compileExpression(source, env.celEnv);
  },

  analyze(source, env) {
    return analyzeCelExpression(source, env);
  },
};

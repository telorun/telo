import { qualifiedCalls, typesEqual, type CelNode, type CelType, type ResultOrigin } from "@telorun/cel";
import { extractAccessChains, INDEX_SEGMENT } from "../cel/analyze.js";
import { wordedVerdicts } from "../cel/verdict-wording.js";
import { compileExpression, repeatableExpression } from "../cel/compile.js";
import { auditCalls, explainUnresolved } from "../cel/diagnose.js";
import { moduleNameBindings, unresolvedCallReceivers } from "../cel/module-call.js";
import type { CelAnalyzeResult, CelDiagnostic } from "../cel/verdict-codes.js";
import type { AnalyzeEnv, CallSite, TemplatingEngine } from "../engine.js";

/** Statically analyze one CEL expression against the environment typed for its
 *  site: parse → classify every call → type-check, the engine judging every
 *  member read, operand and nullable read to full depth, each verdict worded
 *  from the schema node it names. Single source of truth shared by the `!cel` engine
 *  (one expression) and the `!sql` engine (one per `${{ }}` interpolation), so
 *  diagnostic wording can't drift between them.
 *
 *  The type-check lives here, not in the analyzer, so one expression produces
 *  one verdict against one environment. Splitting them let an opaque
 *  "no matching overload" survive next to the diagnostic that actually
 *  explained it, and left `${{ }}` interpolations chain-validated but never
 *  type-checked at all. */
export function analyzeCelExpression(source: string, env: AnalyzeEnv): CelAnalyzeResult {
  return analyzeCelWithTree(source, env).result;
}

/** {@link analyzeCelExpression}, with the resolved tree it built and, where it
 *  checked clean, the type it checked — for a tag that asks its own questions
 *  of one expression without parsing or checking it again. */
export function analyzeCelWithTree(
  source: string,
  env: AnalyzeEnv,
): { result: CelAnalyzeResult; ast?: CelNode; checkedType?: CelType } {
  const out: CelDiagnostic[] = [];

  // **Reading never throws and never discards what it read**: the first unreadable thing is
  // one ranged diagnostic and the tree keeps the longest prefix, so a scalar an author is
  // mid-way through typing still reports its chains and its calls.
  const parsed = env.celEnv.parse(source);
  if (parsed.diagnostics.length > 0) {
    const first = parsed.diagnostics[0]!;
    return {
      result: {
        diagnostics: [{ code: "CEL_SYNTAX_ERROR", message: first.message }],
        calls: [],
      },
    };
  }
  const ast: CelNode = parsed.root;

  // Resolution happened as the expression was READ, over the environment's own namespaces —
  // `qcall` is a node of its own rather than a rewrite — so every walk below already sees
  // the resolved shape and none of them has to know a module name from a variable.
  const resolvedCalls = qualifiedCalls(ast).length > 0;

  // A name bound inside the expression can never be read once a module owns it:
  // `Billing.f(x)` under a comprehension variable named `Billing` resolves to
  // the module. Reported rather than silently shadowed, the rule every other
  // name in CEL scope follows.
  for (const name of moduleNameBindings(ast, env.moduleNames)) {
    out.push({
      code: "BINDING_NAME_RESERVED",
      message:
        `'${name}' names a module here (an imports: alias, Self, or this module's own name), ` +
        `so a call written '${name}.f(…)' resolves to that module and this binding could never ` +
        `be read. Rename the bound variable.`,
    });
  }

  const checked = env.celEnv.check(parsed, {
    schemaNodes: true,
    ...(env.assumptions && env.assumptions.length > 0 ? { assumptions: env.assumptions } : {}),
  });
  const audit = auditCalls(source, ast, env.celEnv, env.moduleCallFlags, checked);

  // Reported whatever the type-checker concludes. A literal argument a guard
  // will refuse is a defect the manifest states outright, and leaving it to the
  // run is the thing static analysis exists to prevent — so it is not gated on
  // `checkError` the way the call audit is.
  out.push(...audit.argumentIssues);

  let type: string | undefined;
  let checkedType: CelType | undefined;
  let origins: readonly ResultOrigin[] | undefined;
  let checkError: string | undefined;
  try {
    // The TREE is checked, never the source again: `check(source)` would re-read it, and a
    // tree resolved under another site's names is refused rather than answered about.
    if (checked.valid) {
      type = checked.typeName;
      checkedType = checked.type;
      origins = checked.resultOrigins;
    } else {
      // **Every verdict is the engine's, coded and ranged.** This used to be one opaque
      // sentence — `found no matching overload for 'f(...)'` for three unrelated mistakes —
      // which is why a classifier sat beside it rewriting the message. The engine decides an
      // unknown name, a name called in the other form, an unknown field, a type no overload
      // takes and a refusal over a literal argument each where its cause is known, so they
      // come through as they are.
      // A member read gets one finding, worded from the node the verdict names.
      for (const diagnostic of wordedVerdicts(source, ast, checked.diagnostics)) {
        out.push({
          code: diagnostic.code,
          message: diagnostic.message,
          ...(diagnostic.fix ? { fix: diagnostic.fix } : {}),
        });
      }
      checkError = checked.diagnostics[0]?.message;
    }
  } catch (e) {
    // The checker is now the ONLY type verdict for every CEL expression, so a
    // crash here silently retires static typing for that expression. Report it
    // instead: degrading is acceptable, degrading invisibly is not.
    return {
      result: {
        diagnostics: [
          {
            code: "CEL_TYPE_ERROR",
            message: `the CEL type-checker failed on this expression: ${
              e instanceof Error ? e.message : String(e)
            }`,
          },
        ],
        calls: audit.calls,
      },
      ast,
    };
  }

  // The audit only ever EXPLAINS a rejection — it never overrules acceptance.
  // Its classification is decided from the registry, so a call cel-js accepts
  // but the registry cannot account for (a macro the parser expands and the
  // registry never sees, which a cel-js upgrade can introduce at any time) must
  // not become a hard error on valid CEL. Reporting nothing where cel-js is
  // happy makes an unknown future macro a silent no-op rather than a manifest
  // this analyzer refuses and the kernel would run fine.

  // An undeclared ROOT identifier. cel-js types an unknown name as `dyn` and
  // accepts it, so `!cel "fff"` type-checked, reached the runtime and resolved
  // to nothing — the one CEL mistake with no static report at all. Member
  // access on a KNOWN root was already covered ("No such key"), which is why a
  // typo one level in was caught and a typo at the root was not.
  //
  // Comprehension variables are not roots: `extractAccessChains` drops the
  // names a `.all(x, …)` binds, so the check never sees them.
  if (env.rootsDeclared) {
    // A receiver that resolved to no module name AND could be one — the host
    // decides the second half, since a name's level is its naming rule, not
    // this engine's. `Foo.bar()` is an unknown identifier like any other, but
    // its repair is an `imports:` alias rather than a different spelling, so it
    // says so; `dbb.query(1)` is a misspelled value and gets no such advice.
    // Walked only once a root is unknown, which a correct expression never has.
    let callReceivers: Set<string> | undefined;
    const reported = new Set<string>();
    for (const chain of extractAccessChains(ast)) {
      const root = chain[0];
      if (!root || reported.has(root) || env.celEnv.hasVariable(root)) continue;
      reported.add(root);
      callReceivers ??= unresolvedCallReceivers(ast, env.moduleNames);
      out.push({
        code: "CEL_UNKNOWN_IDENTIFIER",
        message:
          `unknown identifier '${root}' — nothing by that name is in scope here.` +
          (callReceivers.has(root) && env.couldNameModule?.(root) === true
            ? ` To call a function another module declares, '${root}' must be one of this module's names — an 'imports:' alias, 'Self', or the module's own metadata.name.`
            : ""),
      });
    }
  }

  return {
    result: {
      diagnostics: out,
      calls: audit.calls,
      ...(type === undefined ? {} : { type }),
      ...(checkedType === undefined ? {} : { checkedType }),
      ...(origins === undefined ? {} : { origins }),
      ...(ast.kind === "literal" && ast.literal.type === "string"
        ? { stringLiteral: ast.literal.value }
        : {}),
      ...(checkError === undefined ? {} : chainTypes(ast, env)),
    },
    ast,
    ...(checkedType === undefined ? {} : { checkedType }),
  };
}

/** The checked type of each distinct plain chain the expression reads, as it prints and itself. */
function chainTypes(ast: CelNode, env: AnalyzeEnv): { readTypes: string[]; readCheckedTypes: CelType[] } {
  const names = new Set<string>();
  const types: CelType[] = [];
  for (const chain of extractAccessChains(ast)) {
    if (chain.includes(INDEX_SEGMENT)) continue;
    const result = env.celEnv.check(
      chain.join("."),
      env.assumptions && env.assumptions.length > 0 ? { assumptions: env.assumptions } : {},
    );
    if (!result.valid) continue;
    names.add(result.typeName);
    if (!types.some((held) => typesEqual(held, result.type))) types.push(result.type);
  }
  return { readTypes: [...names], readCheckedTypes: types };
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
    return compileExpression(source, env.celEnv, env.moduleNames, env.programSites);
  },

  analyze(source, env) {
    return analyzeCelExpression(source, env);
  },

  expressionRegions(source) {
    return [{ start: 0, end: source.length }];
  },

  repeatable(source, celEnv) {
    return repeatableExpression(source, celEnv);
  },
};

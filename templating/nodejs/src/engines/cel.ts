import type { ASTNode } from "@marcbachmann/cel-js";
import {
  extractAccessChains,
  extractCallResultAccesses,
  findNullableAccessIssues,
  INDEX_SEGMENT,
  moduleCallArgumentChains,
  validateChainAgainstSchema,
} from "../cel/analyze.js";
import { compileExpression } from "../cel/compile.js";
import { auditCalls, explainUnresolved } from "../cel/diagnose.js";
import {
  moduleCallNodes,
  moduleNameBindings,
  resolveModuleCalls,
  unresolvedCallReceivers,
  type ModuleCall,
} from "../cel/module-call.js";
import type {
  AnalyzeEnv,
  AnalyzeResult,
  CallSite,
  EngineDiagnostic,
  TemplatingEngine,
} from "../engine.js";

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
  return analyzeCelWithTree(source, env).result;
}

/** {@link analyzeCelExpression}, with the resolved tree it built — for a tag
 *  that asks its own questions of one expression without parsing it again. */
export function analyzeCelWithTree(
  source: string,
  env: AnalyzeEnv,
): { result: AnalyzeResult; ast?: ASTNode } {
  const out: EngineDiagnostic[] = [];

  let parsed: ReturnType<typeof env.celEnv.parse>;
  try {
    parsed = env.celEnv.parse(source);
  } catch (e) {
    return {
      result: {
        diagnostics: [{ code: "CEL_SYNTAX_ERROR", message: e instanceof Error ? e.message : String(e) }],
        calls: [],
      },
    };
  }
  const ast: ASTNode = parsed.ast;

  // Resolution, before anything reads the tree — the audit, the type check and
  // every chain walk below all see the resolved shape, so none of them has to
  // know a module name from a variable.
  // The walks that read resolved calls below are skipped when there are none.
  const resolvedCalls = resolveModuleCalls(parsed.ast, env.moduleNames, env.moduleCallType).length > 0;

  // A name bound inside the expression can never be read once a module owns it:
  // `Billing.f(x)` under a comprehension variable named `Billing` resolves to
  // the module. Reported rather than silently shadowed, the rule every other
  // name in CEL scope follows.
  for (const name of moduleNameBindings(parsed.ast, env.moduleNames)) {
    out.push({
      code: "BINDING_NAME_RESERVED",
      message:
        `'${name}' names a module here (an imports: alias, Self, or this module's own name), ` +
        `so a call written '${name}.f(…)' resolves to that module and this binding could never ` +
        `be read. Rename the bound variable.`,
    });
  }

  const audit = auditCalls(source, parsed.ast, env.celEnv, env.moduleCallFlags);

  // Reported whatever the type-checker concludes. A literal argument a guard
  // will refuse is a defect the manifest states outright, and leaving it to the
  // run is the thing static analysis exists to prevent — so it is not gated on
  // `checkError` the way the call audit is.
  out.push(...audit.argumentIssues);

  let type: string | undefined;
  let checkError: string | undefined;
  try {
    // `parsed.check()`, never `celEnv.check(source)`: the latter RE-PARSES, so
    // it would type a tree in which no module call was ever resolved — every
    // one of them reported as a missing method on an unknown receiver.
    const result = parsed.check();
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
  // What explaining a rejection already reported, so the context's own chain
  // check below does not report it twice.
  const explained = new Set<string>();
  if (checkError !== undefined) {
    // `check()` stops at its first problem; the audit enumerates every bad call,
    // which is the whole reason it exists as more than a message rewriter.
    out.push(...audit.diagnostics);
    const unknownFields =
      audit.diagnostics.length === 0 ? explainUnknownFields(parsed.ast, env) : [];
    out.push(...unknownFields);
    for (const d of unknownFields) explained.add(d.message);
    if (audit.diagnostics.length === 0 && unknownFields.length === 0) {
      out.push({
        code: "CEL_TYPE_ERROR",
        message: checkError + explainUnresolved(audit.unresolved, env.celEnv) + DYN_HINT(checkError),
      });
    }
  }

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
    for (const chain of extractAccessChains(parsed.ast)) {
      const root = chain[0];
      if (!root || reported.has(root) || env.celEnv.hasVariable(root)) continue;
      reported.add(root);
      callReceivers ??= unresolvedCallReceivers(parsed.ast, env.moduleNames);
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

  // A module call's result is typed by the callee's declared `returns`, which the
  // caller resolves: member access on it is checked exactly as a read off the
  // context would be, under the call as written.
  if (resolvedCalls && env.moduleCallResult) {
    for (const access of extractCallResultAccesses(parsed.ast)) {
      const schema = env.moduleCallResult(access.qualified);
      if (!schema) continue;
      const label = `${access.qualified}(…)`;
      const err = validateChainAgainstSchema([label, ...access.members], {
        type: "object",
        properties: { [label]: schema },
      });
      if (err) out.push({ code: "CEL_UNKNOWN_FIELD", message: err });
    }
  }

  if (env.contextSchema) {
    const contextSchema = env.contextSchema as Record<string, any>;
    for (const chain of extractAccessChains(parsed.ast)) {
      const err = validateChainAgainstSchema(chain, contextSchema);
      if (err && !explained.has(err)) out.push({ code: "CEL_UNKNOWN_FIELD", message: err });
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

  return {
    result: {
      diagnostics: out,
      calls: resolvedCalls ? withCallArguments(audit.calls, parsed.ast) : audit.calls,
      ...(type === undefined ? {} : { type }),
      ...(ast.op === "value" && typeof ast.args === "string" ? { stringLiteral: ast.args } : {}),
      ...(checkError === undefined ? {} : { readTypes: chainTypes(parsed.ast, env) }),
    },
    ast,
  };
}

/** Every chain naming a field the site's names do not declare, as the host's
 *  explain schema reads them — the readable half of a rejection the checker
 *  reported in its own words. The explain schema is not the checker's
 *  environment, so a chain is reported only when the checker rejects it too;
 *  otherwise the rejection was about something else and keeps its own words. */
function explainUnknownFields(ast: ASTNode, env: AnalyzeEnv): EngineDiagnostic[] {
  const schema = env.explainSchema?.();
  if (!schema) return [];
  const out: EngineDiagnostic[] = [];
  const reported = new Set<string>();
  for (const chain of extractAccessChains(ast)) {
    const message = validateChainAgainstSchema(chain, schema as Record<string, any>);
    if (message && !reported.has(message) && checkerRejects(chain, env)) {
      reported.add(message);
      out.push({ code: "CEL_UNKNOWN_FIELD", message });
    }
  }
  return out;
}

/** The checked type of each distinct plain chain the expression reads. */
function chainTypes(ast: ASTNode, env: AnalyzeEnv): string[] {
  const types = new Set<string>();
  for (const chain of extractAccessChains(ast)) {
    if (chain.includes(INDEX_SEGMENT)) continue;
    const result = env.celEnv.check(chain.join("."));
    if (result.valid && result.type !== undefined) types.add(result.type);
  }
  return [...types];
}

/** Does the checker reject the chain's named prefix (up to its first index)? */
function checkerRejects(chain: readonly string[], env: AnalyzeEnv): boolean {
  const end = chain.indexOf(INDEX_SEGMENT);
  const named = end === -1 ? chain : chain.slice(0, end);
  return !env.celEnv.check(named.join(".")).valid;
}

/** The audited call sites, each module call carrying its arguments as the type
 *  check saw them. Matched by position, which is what identifies one call among
 *  several of the same name. */
function withCallArguments(calls: readonly CallSite[], ast: ASTNode): CallSite[] {
  const byStart = new Map<number, ModuleCall>();
  for (const { node, call } of moduleCallNodes(ast)) byStart.set(node.start, call);
  const chainsByStart = new Map<number, Array<string[] | null>>();
  for (const [node, chains] of moduleCallArgumentChains(ast)) chainsByStart.set(node.start, chains);
  return calls.map((site) => {
    const call = site.moduleCall ? byStart.get(site.start) : undefined;
    if (!call) return site;
    const chains = chainsByStart.get(site.start);
    return {
      ...site,
      arguments: call.args.map((arg, index) => {
        const type = call.argumentTypes?.[index];
        const chain = chains?.[index] ?? null;
        return {
          ...(type !== undefined ? { type } : {}),
          ...(chain && !chain.includes(INDEX_SEGMENT) ? { chain } : {}),
        };
      }),
    };
  });
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
    return compileExpression(source, env.celEnv, env.moduleNames);
  },

  analyze(source, env) {
    return analyzeCelExpression(source, env);
  },

  expressionRegions(source) {
    return [{ start: 0, end: source.length }];
  },
};

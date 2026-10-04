/**
 * A rule's CEL condition: compiling it once, and refusing the ones that cannot
 * be checks.
 *
 * Shared by `x-telo-resource-rules` (fields of one resource) and
 * `x-telo-referrer-rules` (a requirement on whoever references it). The two
 * families differ in what they bind — `this` and `key` versus `referrer` — and
 * in nothing else: same polarity, same cache, same refusals, same budget. Two
 * copies would eventually disagree about which functions a rule may call, which
 * is a soundness property rather than a style one.
 *
 * Browser-safe: no Node built-ins.
 */
import {
  celFunctionCatalog,
  buildCelEnvironment,
  celEngine,
  extractAccessChains,
  interpolationShape,
  MODULE_CALL_DISPATCH_KEY,
  moduleCallNames,
} from "@telorun/templating";
import type { ModuleCallDispatch } from "@telorun/templating";
import { renderChain, type CallableFlags } from "./callable-flags.js";
import { moduleNamesEnvironment, namespaceDispatchOf } from "./cel-environment.js";
import type { DiagnosticFix } from "./types.js";

/**
 * Wall-clock ceiling for one rule over one resource. The rules run on the
 * kernel's boot path and at the editor's keystroke-time analysis, and the
 * comprehension nesting is the RULE AUTHOR's — a dependency's quadratic rule
 * must not be able to hang a consumer's `telo check`.
 *
 * It bounds the SUBJECT LOOP, not one expression: cel-js offers no step limit,
 * so a single pathological expression over one huge element still runs to
 * completion. Stated rather than hidden — the budget catches the shape that
 * actually occurs (a cheap expression over many subjects) and reports the rule
 * as defective rather than truncating coverage silently.
 */
export const RULE_BUDGET_MS = 50;

/**
 * Collapses an EVALUATION-TIME rule failure — a condition that threw on a
 * subject the static check could not foresee, or one that exhausted its budget —
 * to one diagnostic per `(declaring kind, rule code)` per analysis.
 *
 * It used to report per SITE. One upstream defect produced 107 diagnostics
 * across 99 lines, every one pointing at a line the reader does not own and
 * cannot fix: a count that grows with the consumer's manifest size for a single
 * defect in someone else's kind is not an actionable error, it is noise whose
 * cost is superlinear in the thing being checked.
 *
 * Shared by both rule families, like everything else here, because the two would
 * otherwise come to disagree about what one defect costs.
 */
export class RuleFailureLedger {
  private readonly seen = new Set<string>();

  /** True the FIRST time this rule of this kind fails, false after. The caller
   *  drops everything but the first. */
  first(declaringKind: string, rule: string): boolean {
    const key = `${declaringKind}\u0000${rule}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

/**
 * The one message for an untagged `condition:`, shared by every rule family so
 * all of them say the same thing about the same defect.
 *
 * The readers stay lenient and a bare string still runs. What it loses is
 * everything outside evaluation — to the editor's colouring, completion and
 * hover an untagged condition is a plain string, so its author writes CEL with
 * no help and none of the checks a `!cel` scalar gets. Losing that silently is
 * the failure a strict half exists to move earlier.
 */
export const UNTAGGED_CONDITION =
  "Write 'condition' with the !cel tag. The reader is lenient and a bare string still " +
  "runs, but untagged the expression is not CEL to the editor's colouring, completion " +
  "or hover, so a rule silently stops being CEL to every surface but this one.";

/** The repair for {@link UNTAGGED_CONDITION}: the same expression behind the tag.
 *  None for text holding `${{`, which is not the expression. */
export function untaggedConditionFix(condition: string): DiagnosticFix | undefined {
  return interpolationShape(condition) === "none" ? { replacement: condition, tag: "cel" } : undefined;
}

// Read off the catalog's one listing surface, which carries both flags per function.
const HOST_BACKED = new Set(
  celFunctionCatalog()
    .filter((f) => f.hostBacked)
    .map((f) => f.name),
);
const NON_DETERMINISTIC = new Set(
  celFunctionCatalog()
    .filter((f) => !f.deterministic)
    .map((f) => f.name),
);

let sharedEnv: ReturnType<typeof buildCelEnvironment> | undefined;
/** The analyzer's own environment — no host handlers, so every `hostBacked`
 *  entry is a throwing stub. Built once; it is stateless. */
export function ruleEnv(): ReturnType<typeof buildCelEnvironment> {
  sharedEnv ??= buildCelEnvironment();
  return sharedEnv;
}

export type CompiledRule =
  | { parsed: (ctx: Record<string, unknown>) => unknown; chains: readonly (readonly string[])[] }
  | { reason: string };

/**
 * A rule's condition, parsed once per process rather than once per resource.
 *
 * The pass runs over every resource of a kind and at the editor's
 * keystroke-time analysis, so a workspace with fifty tables parsed the same
 * six conditions fifty times each. The source string is the whole key: the
 * environment is stateless and shared, so two identical conditions genuinely
 * compile to the same program. A parse FAILURE is cached too — it is a property
 * of the condition, and re-deriving it per resource costs the same as the
 * success it replaced.
 *
 * BOUNDED, because the editor analyses on every keystroke: a kind author editing
 * a `condition:` interns one entry per character typed, and every one of those
 * intermediate strings is dead the moment the next arrives. Insertion-ordered
 * eviction is enough — the working set is the conditions a workspace actually
 * declares, and a stale entry costs one re-parse.
 */
const RULE_CACHE_LIMIT = 512;
const compiledRules = new Map<string, CompiledRule>();

const EMPTY_NAMES: ReadonlySet<string> = new Set();

export function compileRuleCondition(
  condition: string,
  /** The DECLARING kind's module names. A condition is written by the kind's
   *  author, so a call it makes resolves in that module's scope — not in the
   *  scope of whichever manifest the rule is run against. */
  moduleNames?: ReadonlySet<string>,
): CompiledRule {
  const key = cacheKey(condition, moduleNames);
  const cached = compiledRules.get(key);
  if (cached) return cached;
  let result: CompiledRule;
  // Read against the declaring kind's own names, so a call it writes resolves
  // in that module's scope rather than in whichever manifest the rule runs
  // against.
  const env = moduleNamesEnvironment(ruleEnv(), moduleNames ?? EMPTY_NAMES);
  const parsed = env.parse(condition);
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic) {
    // The text the condition's own CEL pass reports; "unknown", not "reads
    // nothing", so the caller checks the whole of every binding.
    result = { reason: diagnostic.message };
  } else {
    const program = env.compile(parsed);
    result = {
      // The caller hands the module's dispatch table in the activation, under
      // a key outside CEL's identifier grammar, so no author can reach past
      // the export gate. The engine takes it as the per-evaluation namespace
      // seam instead — nothing in an activation can name a function — so it is
      // lifted out here rather than left as a binding the expression could
      // never read.
      parsed: (ctx) => {
        const { [MODULE_CALL_DISPATCH_KEY]: table, ...activation } = ctx;
        return program.evaluate(activation as never, {
          namespaceFunction: namespaceDispatchOf(table as ModuleCallDispatch | undefined),
        });
      },
      chains: extractAccessChains(parsed.root),
    };
  }
  if (compiledRules.size >= RULE_CACHE_LIMIT) {
    const oldest = compiledRules.keys().next();
    if (!oldest.done) compiledRules.delete(oldest.value);
  }
  compiledRules.set(key, result);
  return result;
}

/** The cache key: source AND the name set it was resolved against.
 *
 *  The same text means two different programs in two modules — `Billing.f(x)`
 *  is a module call where `Billing` is imported and a method call on an unknown
 *  receiver where it is not — so keying on the source alone would serve one
 *  module's compilation to the other. Sorted, so declaration order is not a
 *  second entry. */
function cacheKey(condition: string, moduleNames?: ReadonlySet<string>): string {
  return moduleNames === undefined || moduleNames.size === 0
    ? condition
    : `${[...moduleNames].sort().join(",")}\u0000${condition}`;
}

/**
 * Why a condition cannot serve as a check, as messages for the declaring kind.
 *
 * Two refusals beyond the CEL diagnostics themselves, for a catalog function: one
 * the kernel supplies at boot (a throwing stub here, so the rule could never run
 * at `telo check`), and a non-deterministic one (a verdict that depends on when
 * it ran is not a verdict). A MODULE call is judged by the same two flags,
 * derived for the function it reaches — {@link conditionCallRefusals}, asked
 * once every function in the analysis is known.
 */
export function conditionRefusals(
  condition: string,
  moduleNames?: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const result = celEngine.analyze(condition, {
    celEnv: moduleNamesEnvironment(ruleEnv(), moduleNames ?? EMPTY_NAMES),
    contextSchema: null,
    moduleNames,
  });
  for (const diagnostic of result.diagnostics) out.push(`Rule condition: ${diagnostic.message}`);
  for (const call of result.calls) {
    if (call.moduleCall) continue;
    if (HOST_BACKED.has(call.name)) {
      out.push(
        `Rule condition calls '${call.name}()', which the kernel supplies at boot ` +
          "(it needs Node crypto / Buffer). The analyzer registers a throwing stub, so " +
          "the rule cannot run at telo check.",
      );
    } else if (NON_DETERMINISTIC.has(call.name) || call.deterministic === false) {
      out.push(
        `Rule condition calls '${call.name}()', which re-evaluates per call. A check ` +
          "whose verdict depends on when it ran is not a check.",
      );
    }
  }
  return out;
}

/**
 * Why the MODULE calls a condition makes stop it serving as a check — the
 * catalog's two refusals applied through each function's derived flags.
 *
 * A function written in CEL whose body reaches neither kind of leaf passes, and
 * is evaluated by the analyzer when the rule runs. One that reaches a host-backed
 * function — a native function above all, whose code the analyzer never has —
 * could never run here; one that reaches a non-deterministic function would make
 * the verdict depend on when it ran. Each message names the chain to the leaf.
 * A call reaching no function at all could not run either.
 */
export function conditionCallRefusals(
  condition: string,
  moduleNames: ReadonlySet<string>,
  flagsOf: (qualified: string) => CallableFlags | undefined,
): string[] {
  const out: string[] = [];
  const parsed = moduleNamesEnvironment(ruleEnv(), moduleNames).parse(condition);
  // `conditionRefusals` reports the syntax error.
  if (parsed.diagnostics.length > 0) return out;
  const reported = new Set<string>();
  for (const qualified of moduleCallNames(parsed.root)) {
    if (reported.has(qualified)) continue;
    reported.add(qualified);
    const flags = flagsOf(qualified);
    if (!flags) {
      out.push(
        `Rule condition calls '${qualified}', which reaches no function this module can call. ` +
          "A rule is evaluated at telo check, so every call it makes must reach a function " +
          "written in CEL.",
      );
    } else if (flags.hostBacked) {
      out.push(
        `Rule condition calls '${qualified}', which needs the runtime's host ` +
          `(${renderChain(flags.hostBackedVia)}): a native function's code is never available ` +
          "to the analyzer, so the rule could never run at telo check.",
      );
    } else if (!flags.deterministic) {
      out.push(
        `Rule condition calls '${qualified}', which re-evaluates per call ` +
          `(${renderChain(flags.nondeterministicVia)}). A check whose verdict depends on when ` +
          "it ran is not a check.",
      );
    }
  }
  return out;
}

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
  CEL_FUNCTIONS,
  buildCelEnvironment,
  celEngine,
  extractAccessChains,
} from "@telorun/templating";

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

const HOST_BACKED = new Set(CEL_FUNCTIONS.filter((f) => f.hostBacked).map((f) => f.name));
const NON_DETERMINISTIC = new Set(
  CEL_FUNCTIONS.filter((f) => !f.deterministic).map((f) => f.name),
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

export function compileRuleCondition(
  condition: string,
  /** Chain roots to assume when the parse yields no AST — "unknown", not
   *  "reads nothing", so the caller checks the whole of every binding. */
  fallbackRoots: readonly string[],
): CompiledRule {
  const cached = compiledRules.get(condition);
  if (cached) return cached;
  let result: CompiledRule;
  try {
    const parsed = ruleEnv().parse(condition) as (ctx: Record<string, unknown>) => unknown;
    const ast = (parsed as unknown as { ast?: unknown }).ast;
    result = {
      parsed,
      chains: ast ? extractAccessChains(ast as never) : fallbackRoots.map((root) => [root]),
    };
  } catch (err) {
    result = { reason: err instanceof Error ? err.message : String(err) };
  }
  if (compiledRules.size >= RULE_CACHE_LIMIT) {
    const oldest = compiledRules.keys().next();
    if (!oldest.done) compiledRules.delete(oldest.value);
  }
  compiledRules.set(condition, result);
  return result;
}

/**
 * Why a condition cannot serve as a check, as messages for the declaring kind.
 *
 * Two refusals beyond the CEL diagnostics themselves: a function the kernel
 * supplies at boot (a throwing stub here, so the rule could never run at
 * `telo check`), and a non-deterministic one (a verdict that depends on when it
 * ran is not a verdict).
 */
export function conditionRefusals(condition: string): string[] {
  const out: string[] = [];
  const result = celEngine.analyze(condition, { celEnv: ruleEnv(), contextSchema: null });
  for (const diagnostic of result.diagnostics) out.push(`Rule condition: ${diagnostic.message}`);
  for (const call of result.calls) {
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

/**
 * **A type rule's condition, parsed as the module that declared it wrote it.**
 *
 * A condition is CEL evaluated against the value alone, wherever the shape is
 * checked, so no module's functions are bound there. It is still parsed with the
 * declaring module's names, so a call through one of them resolves to a module
 * call — and fails as the unbound call it is, naming the function, rather than as
 * a method no overload of a value answers. `telo check` refuses such a condition
 * where it is written (`FUNCTION_CALL_UNBOUND`); this is the runtime half.
 *
 * Parsed once per rule object: a shape is checked on every dispatch that names
 * it.
 */
import { parse } from "@marcbachmann/cel-js";
import type { TypeRule } from "@telorun/sdk";
import { resolveModuleCalls } from "@telorun/templating";

export type RuleCondition = (data: unknown) => unknown;

const callNamesByRule = new WeakMap<TypeRule, ReadonlySet<string>>();
const conditions = new WeakMap<TypeRule, RuleCondition>();

/** Record the names the module declaring `rules` resolves calls through. Every
 *  site that hands rules to the runtime stamps them. */
export function stampRuleCallNames(rules: readonly TypeRule[], names: ReadonlySet<string>): void {
  for (const rule of rules) callNamesByRule.set(rule, names);
}

/** The evaluator for `rule`'s condition. */
export function ruleCondition(rule: TypeRule): RuleCondition {
  const cached = conditions.get(rule);
  if (cached) return cached;
  const names = callNamesByRule.get(rule);
  if (!names) {
    throw new Error(
      `kernel defect: the type rule '${rule.code}' reached evaluation without the names of the ` +
        `module that declared it`,
    );
  }
  const parsed = parse(rule.condition);
  resolveModuleCalls(parsed.ast, names);
  const condition: RuleCondition = (data) => parsed({ this: data });
  conditions.set(rule, condition);
  return condition;
}

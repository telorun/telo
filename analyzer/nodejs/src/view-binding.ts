/**
 * A forward view's DEFINITION BINDING: what the view's consumer gives each of
 * the definition's own dimensions, over the configuration dimensions alone.
 *
 * Each dimension's local key is evaluated over the consumer exactly as the
 * consumer's expansion evaluates a choice (its `valueIn`); a view built from a
 * view reads its upstream view's values, the root consumer's options held in
 * place, so its binding is composed through its holder's. A domain value, a
 * selector's case key or a truth value is its index; a selector value no case
 * names is the selector's other value; an open or non-evaluating value, a
 * closed dimension's value outside its domain and a loop binding's dimension
 * are free where they hold. Over one configuration every condition is a fact.
 *
 * Browser-safe.
 */
import { caseKeyValue, celTypeOfValue } from "./choice-reading.js";
import { FALSE, type Condition, type ConditionSpace, type DefinitionDimension } from "./presence-condition.js";
import { OTHER_VALUE } from "./template-definition-check.js";

/** One value an expression takes over a consumer, and where: `open` where it
 *  is computed, undecided or does not evaluate. */
export type BindingOutcome =
  | { readonly value: unknown; readonly condition: Condition }
  | { readonly open: true; readonly condition: Condition };

/** What a view's consumer gives an expression its body's choices read. */
export interface ViewBinding {
  /** Every outcome of `source` over the consumer, each where it holds. */
  outcomesOf(source: string): readonly BindingOutcome[];
}

let checkingCompositions = false;

/** Check, until the returned function is called, that every composition
 *  through a binding reads no definition dimension. */
export function checkBindingCompositions(): () => void {
  checkingCompositions = true;
  return () => {
    checkingCompositions = false;
  };
}

/**
 * `condition` — over the configurations and one definition's own dimensions —
 * composed through `binding`: each definition dimension replaced by where the
 * consumer gives it each value, so it reads configuration dimensions alone. A
 * condition reading no definition dimension is itself.
 */
export function composedThrough(condition: Condition, binding: ViewBinding | undefined, space: ConditionSpace): Condition {
  if (!space.readsDefinition(condition)) return condition;
  if (!binding) throw new Error("internal: a finding of a definition's own dimensions covers a view no binding was built for.");
  const out = space.translate(condition, space, (key) => {
    const dimension = space.definitionOf(key);
    if (!dimension) return { key };
    return { values: bindingVector(binding, dimension, space.dimensions[space.levelOfKey(key)]!.values, space) };
  });
  if (checkingCompositions && space.readsDefinition(out)) {
    throw new Error("internal: a composition through a view's binding still reads a definition dimension.");
  }
  return out;
}

/** Where the binding gives `dimension` each value of `values`, its domain. */
function bindingVector(
  binding: ViewBinding,
  dimension: DefinitionDimension,
  values: readonly unknown[],
  space: ConditionSpace,
): Condition[] {
  const out: Condition[] = values.map(() => FALSE);
  for (const outcome of binding.outcomesOf(dimension.key)) {
    const index = "open" in outcome ? -1 : indexOf(dimension, values, outcome.value);
    if (index < 0) for (let i = 0; i < out.length; i++) out[i] = space.or(out[i]!, outcome.condition);
    else out[index] = space.or(out[index]!, outcome.condition);
  }
  return out;
}

/** The index of the value `value` gives `dimension`, or -1 where it is free. */
function indexOf(dimension: DefinitionDimension, values: readonly unknown[], value: unknown): number {
  if (dimension.role === "atom") return typeof value === "boolean" ? values.indexOf(value) : -1;
  if (dimension.role === "selector") {
    const type = celTypeOfValue(value);
    const index = values.findIndex((key) => key !== OTHER_VALUE && typeof key === "string" && caseKeyValue(key, type) === value);
    return index >= 0 ? index : values.indexOf(OTHER_VALUE);
  }
  return values.findIndex((member) => sameValue(member, value));
}

/** A domain value, as the schema writes it, against a CEL value. */
function sameValue(member: unknown, value: unknown): boolean {
  const cel = typeof member === "number" && Number.isInteger(member) ? BigInt(member) : member;
  if (cel === value) return true;
  if (typeof value === "bigint" && typeof member === "number") return Number(value) === member;
  if (typeof value === "number" && typeof member === "number") return value === member;
  return false;
}

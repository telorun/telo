import { isCelRecord, MAX_INT, MIN_INT } from "@telorun/cel";
import { isCompiledValue } from "./compiled-value.js";

/**
 * A pure step's `value:` as CEL reads it: every number WRITTEN in it — the whole
 * value, or at any depth of a literal map or list — is an int when integral and
 * a double otherwise, which is JSON Schema's own integer rule and what the same
 * number written inside `!cel` already is. YAML hands every number over as a
 * double, so `value: 3` then `steps.x.result * 2` had no overload to take.
 *
 * Only the literal tree is read. A compiled member (`!cel`, `!interpolate`) is
 * left for evaluation, and whatever it computes is never converted; a value that
 * is not a plain container (bytes, a branded CEL value) is left as it is.
 * Copy-on-write, so the manifest the step was loaded from is untouched.
 */
export function literalStepValue(value: unknown): unknown {
  if (typeof value === "number") return literalNumber(value);
  if (value === null || typeof value !== "object") return value;
  const held = converted.get(value);
  if (held !== undefined) return held;
  const result = literalContainer(value);
  converted.set(value, result);
  return result;
}

/** One conversion per written container: a step body runs once per call. */
const converted = new WeakMap<object, object>();

function literalNumber(value: number): number | bigint {
  if (!Number.isInteger(value)) return value;
  const integer = BigInt(value);
  // An integral double outside int64 is no CEL int; it stays the double it is.
  return integer >= MIN_INT && integer <= MAX_INT ? integer : value;
}

function literalContainer(value: object): object {
  if (isCompiledValue(value)) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = literalMember(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (!isCelRecord(value)) return value;
  let copy: Record<string, unknown> | undefined;
  for (const [key, member] of Object.entries(value)) {
    const next = literalMember(member);
    if (next === member) continue;
    copy ??= { ...value };
    copy[key] = next;
  }
  return copy ?? value;
}

function literalMember(value: unknown): unknown {
  if (typeof value === "number") return literalNumber(value);
  return value !== null && typeof value === "object" ? literalContainer(value) : value;
}

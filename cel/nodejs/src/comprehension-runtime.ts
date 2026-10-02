/**
 * What a comprehension macro **does**, as a function of its range and its body.
 *
 * The macros are lowered by each backend — there is no comprehension node in the tree,
 * because expanding one at read time would make the source unwritable from the tree —
 * but what the lowering *means* lives here, once. The closure backend passes a closure
 * as the body and the emitter will pass an emitted function, and both get the same
 * answers, including the error rules.
 *
 * **An error does not win over a decided answer**, with the one exception named below: `all`
 * is `false` as soon as one element is false even if another errors, and `exists` is `true` as
 * soon as one is true. That is the same rule `&&` and `||` follow, and it is what makes a
 * comprehension over partly-unreadable data usable at all.
 *
 * **An element entering a body is a door a host value comes through**, and it is checked for a
 * thenable here — in the one place a comprehension's meaning lives, so both backends inherit it
 * rather than each remembering to. It is not the leak it looks like: `xs.all(e, true)` over a
 * host list holding a promise used to answer **`true`**, having decided something about a value
 * it never touched, which is the worse half of the failure class. The cost is one `typeof` per
 * element, the same check the member read already makes, on a loop that already calls a closure
 * per element.
 *
 * **That refusal is TERMINAL, and it is the one error here that does not short-circuit.** It is
 * checked where the element is BOUND, before the body runs, and it ends the comprehension
 * whatever a later element would have decided — so `xs.all(e, false)` and `xs.exists(e, true)`
 * refuse rather than answering `false` and `true` off the one element that is readable. The
 * distinction is what the error is ABOUT: `no_such_key` is a fact about one datum, so a decided
 * answer may legitimately outrank it, while a value that must be awaited says the host handed
 * this engine something it cannot evaluate at all. Carrying that past a convenient element makes
 * the answer depend on how many elements happen to be readable and in what order — and the rule
 * is subtle enough that two readers in a row took the discardable refusal for a leak instead.
 */

import type { CelValue } from "./cel-value.js";
import { asyncValueRefused, celError, isCelError, type CelError } from "./cel-value.js";
import type { SourceRange } from "./syntax-tree.js";

/** The body of a comprehension: the value its expression answers for one element. */
export type ComprehensionBody = (element: CelValue) => CelValue;

function notBool(value: CelValue, range?: SourceRange): CelError {
  return celError(
    "no_matching_overload",
    `a comprehension's test must answer a bool, and it answered ${typeof value}`,
    range,
  );
}

/**
 * Whether an element entering a body is one that must be awaited.
 *
 * The `typeof` is inlined here rather than left to the call, because this runs once per element
 * on the engine's hottest loop and only an OBJECT can be a thenable. Measured on a
 * 100k-element `map` over integers — a body that does almost nothing, so the check is as
 * visible as it ever gets: calling unconditionally cost about 4 ms, and with the `typeof`
 * guarding the call the difference sits at this machine's noise floor.
 */
function awaited(element: CelValue, range?: SourceRange): CelError | undefined {
  if (typeof element !== "object" || element === null) return undefined;
  return asyncValueRefused(element, range);
}

/** A predicate's answer for one element: `true`, `false`, or the error it is. */
function test(body: ComprehensionBody, element: CelValue, range?: SourceRange): boolean | CelError {
  const answered = body(element);
  if (isCelError(answered)) return answered;
  if (typeof answered !== "boolean") return notBool(answered, range);
  return answered;
}

export function celAll(
  elements: readonly CelValue[],
  body: ComprehensionBody,
  range?: SourceRange,
): CelValue {
  let failure: CelError | undefined;
  for (const element of elements) {
    const refused = awaited(element, range);
    if (refused) return refused;
    const answered = test(body, element, range);
    if (answered === false) return false;
    if (answered !== true && !failure) failure = answered;
  }
  return failure ?? true;
}

export function celExists(
  elements: readonly CelValue[],
  body: ComprehensionBody,
  range?: SourceRange,
): CelValue {
  let failure: CelError | undefined;
  for (const element of elements) {
    const refused = awaited(element, range);
    if (refused) return refused;
    const answered = test(body, element, range);
    if (answered === true) return true;
    if (answered !== false && !failure) failure = answered;
  }
  return failure ?? false;
}

/** Exactly one element satisfies the test. An error anywhere leaves no count to trust. */
export function celExistsOne(
  elements: readonly CelValue[],
  body: ComprehensionBody,
  range?: SourceRange,
): CelValue {
  let found = 0;
  for (const element of elements) {
    const refused = awaited(element, range);
    if (refused) return refused;
    const answered = test(body, element, range);
    if (isCelError(answered)) return answered;
    if (answered) found += 1;
  }
  return found === 1;
}

export function celFilter(
  elements: readonly CelValue[],
  body: ComprehensionBody,
  range?: SourceRange,
): CelValue {
  const kept: CelValue[] = [];
  for (const element of elements) {
    const refused = awaited(element, range);
    if (refused) return refused;
    const answered = test(body, element, range);
    if (isCelError(answered)) return answered;
    if (answered) kept.push(element);
  }
  return kept;
}

/** `map` in both arities: with a filter, an element the filter drops is not transformed. */
export function celMapComprehension(
  elements: readonly CelValue[],
  transform: ComprehensionBody,
  filter?: ComprehensionBody,
  range?: SourceRange,
): CelValue {
  const out: CelValue[] = [];
  for (const element of elements) {
    const refused = awaited(element, range);
    if (refused) return refused;
    if (filter) {
      const answered = test(filter, element, range);
      if (isCelError(answered)) return answered;
      if (!answered) continue;
    }
    const value = transform(element);
    if (isCelError(value)) return value;
    out.push(value);
  }
  return out;
}

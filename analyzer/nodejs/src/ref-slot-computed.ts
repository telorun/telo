import { CEL_ENGINE, isTaggedSentinel } from "@telorun/templating";
import type { ReachPosition } from "./reference-reach.js";
import { isSelfForward } from "./template-self-forward.js";

/**
 * AN EXPRESSION IS NEVER EVALUATED AT OR ABOVE A REFERENCE SLOT.
 *
 * A reference slot legitimately holds a `{kind, name}` reference, a live
 * instance, an inline declaration, a value-branch scalar and — at a type slot —
 * raw JSON Schema, so a check keyed on the value's SHAPE would refuse legal
 * data. The one unambiguously wrong thing is that an EXPRESSION occupies the
 * position: CEL values are data, so the reference cannot survive it. The single
 * exemption is a bare `self.<path>`, which a template body NAVIGATES rather
 * than evaluates and which is the sanctioned carrier for a reference the
 * instance holds.
 *
 * This is the one reader of that predicate. The static verdict
 * (`REF_SLOT_COMPUTED`, at a template body's entry and at a resource field the
 * kind evaluates at creation) and both kernel refusal sites
 * (`ERR_REF_SLOT_COMPUTED`, at a body's `self`-expansion and at the compile-eval
 * expansion `create()` performs) read it, so the position sets agree by
 * construction rather than by two implementations of a heuristic.
 *
 * Browser-safe; re-imported by the kernel.
 */
export interface ComputedRefSlot {
  /** The expression's concrete path, as written (`routes[0]`, `node.next`). */
  path: string;
  /** The declared pattern of the reference slot the expression holds. */
  fieldPath: string;
  /** The expression's source text. */
  source: string;
}

/** The CEL source of a value that will be evaluated where it stands — in both
 *  forms the two halves hold one: the analyzer's tagged sentinel and the
 *  kernel's precompiled value, which carries the same `engine` / `source`
 *  stamp. A bare `self.<path>` is navigated rather than evaluated, so it is not
 *  one. */
export function evaluatedCelSource(value: unknown): string | undefined {
  if (!isTaggedSentinel(value) || value.engine !== CEL_ENGINE) return undefined;
  return isSelfForward(value.source) ? undefined : value.source;
}

/**
 * Every position of a resource at or ABOVE one of its reference slots whose
 * value is an expression — the slot itself, and each container on the way to it,
 * since an expression above a slot leaves no concrete site below it yet holds
 * the slot's value.
 *
 * `isEvaluated` says which positions the host will actually evaluate: a template
 * body expands all of them, while a resource's own fields are evaluated at
 * creation only where the kind marks them compile-eval.
 */
export function computedRefSlots(
  positions: readonly ReachPosition[],
  isEvaluated: (path: string) => boolean = () => true,
): ComputedRefSlot[] {
  const out: ComputedRefSlot[] = [];
  for (const position of positions) {
    const source = evaluatedCelSource(position.value);
    if (source === undefined || !isEvaluated(position.path)) continue;
    out.push({ path: position.path, fieldPath: position.fieldPath, source });
  }
  return out;
}

/** Why the expression cannot stay, in the wording both halves share. `at` names
 *  what holds it (`on the Http.Api entry 'api'`) where that is not already
 *  clear from the diagnostic's own subject. The repair differs by position:
 *  inside a template body a reference the INSTANCE holds is forwarded verbatim,
 *  while a resource field has nothing to forward. */
export function refSlotComputedReason(
  slot: ComputedRefSlot,
  options: { at?: string; forwardable?: boolean } = {},
): string {
  return (
    `'${slot.path}: !cel "${slot.source}"'${options.at ? ` ${options.at}` : ""} computes a ` +
    `value that holds the reference slot '${slot.fieldPath}'. CEL values are data, so the ` +
    `reference cannot survive the expression. ` +
    (options.forwardable
      ? `Forward it verbatim with a bare 'self.<path>' (the whole value, shaped as the ` +
        `slot expects), or write the slot itself as '!ref'.`
      : `Write the slot itself as '!ref'.`)
  );
}

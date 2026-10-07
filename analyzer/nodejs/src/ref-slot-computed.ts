import { isCompiledValue } from "@telorun/sdk";
import { CEL_ENGINE, defaultRegistry, isTaggedSentinel } from "@telorun/templating";
import { celEvalModeAt, type CelEvalSites } from "./eval-paths.js";
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
 * kind evaluates — marked `x-telo-eval` in either mode, or covered by a
 * region) and both kernel refusal sites
 * (`ERR_REF_SLOT_COMPUTED`, at a body's `self`-expansion and at `create()`,
 * before any field is expanded) read it, so the position sets agree by
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
  /** The tag it is written under (`cel`, `interpolate`). */
  tag: string;
}

/** The CEL source of a value that will be evaluated where it stands — in both
 *  forms the two halves hold one: the analyzer's tagged sentinel and the
 *  kernel's precompiled value, which carries the same `engine` / `source`
 *  stamp. A bare `self.<path>` is navigated rather than evaluated, so it is not
 *  one. */
export function evaluatedCelSource(value: unknown): string | undefined {
  const computed = computedValue(value);
  return computed?.tag === CEL_ENGINE ? computed.source : undefined;
}

/** The tag and source of a value that is COMPUTED where it stands: any tag
 *  whose engine evaluates expressions (`!cel`, `!interpolate`, `!sql`), asked of
 *  the engine rather than of its name. */
function computedValue(value: unknown): { tag: string; source: string } | undefined {
  if (!isTaggedSentinel(value) && !isCompiledValue(value)) return undefined;
  const { engine, source } = value as { engine?: unknown; source?: unknown };
  if (typeof engine !== "string" || typeof source !== "string") return undefined;
  if (!defaultRegistry().get(engine)?.expressionRegions) return undefined;
  if (engine === CEL_ENGINE && isSelfForward(source)) return undefined;
  return { tag: engine, source };
}

/**
 * Every position of a resource at or ABOVE one of its reference slots whose
 * value is an expression — the slot itself, and each container on the way to it,
 * since an expression above a slot leaves no concrete site below it yet holds
 * the slot's value.
 *
 * `isEvaluated` says which positions the host will actually evaluate: a template
 * body expands all of them, while a resource's own fields are evaluated only
 * where the kind says so ({@link evaluatedField}).
 */
export function computedRefSlots(
  positions: readonly ReachPosition[],
  isEvaluated: (path: string) => boolean = () => true,
): ComputedRefSlot[] {
  const out: ComputedRefSlot[] = [];
  for (const position of positions) {
    const computed = computedValue(position.value);
    if (computed === undefined || !isEvaluated(position.path)) continue;
    out.push({ path: position.path, fieldPath: position.fieldPath, ...computed });
  }
  return out;
}

/**
 * Whether a resource's own field at `path` is one the kind evaluates — whatever
 * the one eval-mode question answers `compile` or `runtime` for: a field marked
 * `x-telo-eval`, and a field a region covers (`x-telo-context`,
 * `x-telo-error-context`, a step context), which is how a per-request field
 * says so. Either way the expression's result is data, and a reference slot at
 * or below it is left holding data.
 */
export function evaluatedField(sites: CelEvalSites, path: string): boolean {
  const mode = celEvalModeAt(sites, path);
  return mode === "compile" || mode === "runtime";
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
    `'${slot.path}: !${slot.tag} "${slot.source}"'${options.at ? ` ${options.at}` : ""} computes a ` +
    `value that holds the reference slot '${slot.fieldPath}'. CEL values are data, so the ` +
    `reference cannot survive the expression. ` +
    (options.forwardable
      ? `Forward it verbatim with a bare 'self.<path>' (the whole value, shaped as the ` +
        `slot expects), or write the slot itself as '!ref'.`
      : `Write the slot itself as '!ref'.`)
  );
}

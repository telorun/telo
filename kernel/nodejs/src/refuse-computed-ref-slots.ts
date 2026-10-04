import {
  computedRefSlots,
  refSlotComputedReason,
  type ReachPosition,
} from "@telorun/analyzer";
import { RuntimeError, type ResourceManifest } from "@telorun/sdk";

/** Resolves a declaration's reference positions in the module its
 *  `metadata.module` names — the kernel's resource context. */
export interface RefPositionHost {
  referencePositionsOf(resource: ResourceManifest, data?: unknown): ReachPosition[];
}

/**
 * AN EXPRESSION IS NEVER EVALUATED AT OR ABOVE A REFERENCE SLOT.
 *
 * The runtime half of `REF_SLOT_COMPUTED`, raised at both expansion sites the
 * kernel owns — a template body's `self`-expansion, and the compile-eval
 * expansion `create()` performs for any resource — BEFORE evaluating, and from
 * the SAME reader the static verdict uses (`computedRefSlots`), so the two
 * halves cannot disagree about which positions are refused.
 *
 * What it replaces is a refusal that was lazy and conditional: Phase-5
 * injection leaves a non-reference value at a reference site by design, and
 * `ctx.resolveRef` / `resolveRefInstance` is what eventually refuses it, at
 * DEREFERENCE time, as `ERR_REF_UNRESOLVED`. That backstop is unchanged — it
 * fires at request time in one manifest and never in another, which is why it
 * cannot be the refusal.
 */
export function refuseComputedRefSlots(
  subject: string,
  positions: readonly ReachPosition[],
  options: { isEvaluated?: (path: string) => boolean; forwardable?: boolean } = {},
): void {
  for (const slot of computedRefSlots(positions, options.isEvaluated)) {
    throw new RuntimeError(
      "ERR_REF_SLOT_COMPUTED",
      `${subject}: ${refSlotComputedReason(slot, { forwardable: options.forwardable })}`,
    );
  }
}

import type { ResourceHandle, ResourceInstance } from "./resource-instance.js";

/**
 * One co-referrer of a `callsCoReferrers` slot's target, as
 * `ctx.resolveCoReferrers(slot)` answers it (`Ref.CoReferrers`): a module-scope
 * declaration of the slot's co-referrer kind whose own slot names the same
 * target in the same module instance.
 *
 * `instance` is live, so the caller dispatches it through the kernel —
 * `ctx.invokeResolved(target.ref.kind, target.ref.name, instance, inputs, ctx)` —
 * which gives it a dispatch span of its own, the caller's zones and its
 * cancellation.
 */
export interface CoReferrer {
  /** The co-referrer's resource handle: its canonical kind and the name it is
   *  registered under (a family member's identity included). */
  target: ResourceHandle;
  instance: ResourceInstance;
}

import {
  deriveContext,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { pinZone } from "./enqueue-zone.js";

/**
 * An enqueue kind of this module: the queue module's own operation, asked to
 * run inside the transaction its kind requires.
 *
 * The requirement sits at the kind's schema root, so the kernel finds the zone
 * (or refuses with `ERR_ZONE_REQUIRED`) through the field-less
 * `ctx.requireZone`; the entry it returns is pinned on a context derived for
 * this one call, and the store writes on exactly that entry. Everything else —
 * the size bound, the id, the encoding, every refusal — is the queue module's
 * operation, unchanged.
 */
export class ZonedEnqueue<I, O> implements ResourceInstance<I, O> {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly operation: { invoke(inputs: I, invokeCtx?: InvokeContext): Promise<O> },
  ) {}

  async invoke(inputs: I, invokeCtx?: InvokeContext): Promise<O> {
    const zone = this.ctx.requireZone(invokeCtx);
    const base = invokeCtx ?? this.ctx.rootContext();
    const pinned = deriveContext(base, {});
    pinZone(pinned, zone);
    return this.operation.invoke(inputs, pinned);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

import type { InvokeContext, ZoneEntry } from "@telorun/sdk";

/**
 * The transaction zone an enqueue kind found for a call, handed to the store
 * with the call's context. `QueueSql.Enqueue` asks the kernel for its root zone
 * requirement and pins the entry it got on a context derived for that one call;
 * the store then writes on exactly that entry rather than looking for one.
 * Module scope is one scope here: every engine module re-exports this module's
 * controllers rather than inlining them.
 */
const pinned = new WeakMap<InvokeContext, ZoneEntry>();

export function pinZone(ctx: InvokeContext, zone: ZoneEntry): void {
  pinned.set(ctx, zone);
}

export function pinnedZone(ctx: InvokeContext | undefined): ZoneEntry | undefined {
  return ctx ? pinned.get(ctx) : undefined;
}

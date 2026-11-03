import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { Enqueue } from "@telorun/queue";
import { ZonedEnqueue } from "./zoned-enqueue.js";

export function register(): void {}

/** QueueSql.Enqueue — `Queue.Enqueue` inside the caller's transaction. */
export async function create(
  resource: Parameters<typeof Enqueue.create>[0],
  ctx: ResourceContext,
): Promise<ResourceInstance<unknown, unknown>> {
  const operation = (await Enqueue.create(resource, ctx)) as {
    invoke(inputs: unknown, invokeCtx?: InvokeContext): Promise<unknown>;
  };
  return new ZonedEnqueue(ctx, operation);
}

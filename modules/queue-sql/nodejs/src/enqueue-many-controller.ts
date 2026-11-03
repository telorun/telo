import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { EnqueueMany } from "@telorun/queue";
import { ZonedEnqueue } from "./zoned-enqueue.js";

export function register(): void {}

/** QueueSql.EnqueueMany — `Queue.EnqueueMany` inside the caller's transaction. */
export async function create(
  resource: Parameters<typeof EnqueueMany.create>[0],
  ctx: ResourceContext,
): Promise<ResourceInstance<unknown, unknown>> {
  const operation = (await EnqueueMany.create(resource, ctx)) as {
    invoke(inputs: unknown, invokeCtx?: InvokeContext): Promise<unknown>;
  };
  return new ZonedEnqueue(ctx, operation);
}

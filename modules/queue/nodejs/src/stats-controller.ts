import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundQueueOperation, type OperationResource } from "./queue-operation.js";
import type { QueueStats } from "./queue-store-contract.js";

/** Queue.Stats — the store's counts, as it reports them. */
class QueueStatsOperation implements ResourceInstance<Record<string, never>, QueueStats> {
  constructor(private readonly bound: BoundQueueOperation) {}

  async invoke(inputs: Record<string, never>, invokeCtx?: InvokeContext): Promise<QueueStats> {
    const store = this.bound.store;
    const stats = await this.bound.call(() => store.stats(invokeCtx));
    return {
      pending: stats.pending,
      scheduled: stats.scheduled,
      running: stats.running,
      dead: stats.dead,
      oldestPendingAge: stats.oldestPendingAge,
      exact: stats.exact,
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(
  resource: OperationResource,
  ctx: ResourceContext,
): Promise<QueueStatsOperation> {
  return new QueueStatsOperation(new BoundQueueOperation("Queue.Stats", resource, ctx));
}

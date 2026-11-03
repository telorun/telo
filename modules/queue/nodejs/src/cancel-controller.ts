import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundQueueOperation, storeInconsistent, type OperationResource } from "./queue-operation.js";
import type { MessageState } from "./queue-store-contract.js";

interface CancelOutput {
  id: string;
  cancelled: boolean;
  state: MessageState | "unknown";
}

/** Queue.Cancel — cancel by id; a running message is cancelled at its
 *  handler's next lease renewal, so it still reads `running` here. */
class QueueCancel implements ResourceInstance<{ id: string; reason?: string }, CancelOutput> {
  constructor(private readonly bound: BoundQueueOperation) {}

  async invoke(inputs: { id: string; reason?: string }, invokeCtx?: InvokeContext): Promise<CancelOutput> {
    const store = this.bound.addressableStore;
    const outcome = await this.bound.call(() => store.cancel(inputs.id, inputs.reason ?? null, invokeCtx));
    switch (outcome.status) {
      case "cancelled":
        return { id: inputs.id, cancelled: true, state: "cancelled" };
      case "requested":
        return { id: inputs.id, cancelled: true, state: "running" };
      case "unchanged":
        return { id: inputs.id, cancelled: false, state: outcome.state };
      case "absent":
        return { id: inputs.id, cancelled: false, state: "unknown" };
      default:
        throw storeInconsistent(this.bound.describe, `${JSON.stringify(outcome)} for a cancel`);
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<QueueCancel> {
  return new QueueCancel(new BoundQueueOperation("Queue.Cancel", resource, ctx));
}

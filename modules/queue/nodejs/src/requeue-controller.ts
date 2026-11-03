import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundQueueOperation, storeInconsistent, type OperationResource } from "./queue-operation.js";
import type { MessageState } from "./queue-store-contract.js";

interface RequeueOutput {
  id: string;
  requeued: boolean;
  state: MessageState | "unknown";
}

/** Queue.Requeue — a dead message back to pending, attempts reset. */
class QueueRequeue implements ResourceInstance<{ id: string }, RequeueOutput> {
  constructor(private readonly bound: BoundQueueOperation) {}

  async invoke(inputs: { id: string }, invokeCtx?: InvokeContext): Promise<RequeueOutput> {
    const store = this.bound.addressableStore;
    const outcome = await this.bound.call(() => store.requeue(inputs.id, invokeCtx));
    switch (outcome.status) {
      case "requeued":
        return { id: inputs.id, requeued: true, state: "pending" };
      case "unchanged":
        return { id: inputs.id, requeued: false, state: outcome.state };
      case "absent":
        return { id: inputs.id, requeued: false, state: "unknown" };
      default:
        throw storeInconsistent(this.bound.describe, `${JSON.stringify(outcome)} for a requeue`);
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<QueueRequeue> {
  return new QueueRequeue(new BoundQueueOperation("Queue.Requeue", resource, ctx));
}

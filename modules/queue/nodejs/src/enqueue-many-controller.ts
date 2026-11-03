import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { enqueuedOf, enqueueRequestOf, type EnqueueItem } from "./enqueue-request.js";
import { BoundQueueOperation, type OperationResource } from "./queue-operation.js";

interface EnqueueManyInput {
  messages: EnqueueItem[];
}

interface EnqueueManyOutput {
  messages: Array<{ id: string; enqueued: boolean }>;
}

/**
 * Queue.EnqueueMany — store a batch in one store call. Every body is encoded
 * and bounded before the store is called, so a too-large message stores
 * nothing of the batch; a conflict is reported for the first item that has
 * one, the others having been stored or not as the store answered.
 */
class QueueEnqueueMany implements ResourceInstance<EnqueueManyInput, EnqueueManyOutput> {
  constructor(private readonly bound: BoundQueueOperation) {}

  async invoke(input: EnqueueManyInput, invokeCtx?: InvokeContext): Promise<EnqueueManyOutput> {
    const store = this.bound.store;
    const settings = store.settings();
    const carrier = this.bound.ctx.traceCarrier(invokeCtx);
    const requests = input.messages.map((item, index) =>
      enqueueRequestOf(this.bound.describe, item, settings, carrier, index),
    );
    const outcomes = await this.bound.call(() => store.enqueue(requests, invokeCtx));
    return {
      messages: requests.map((request, index) => ({
        id: request.id,
        enqueued: enqueuedOf(this.bound.describe, request.id, outcomes[index], index),
      })),
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(
  resource: OperationResource,
  ctx: ResourceContext,
): Promise<QueueEnqueueMany> {
  return new QueueEnqueueMany(new BoundQueueOperation("Queue.EnqueueMany", resource, ctx));
}

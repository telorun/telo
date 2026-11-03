import { InvokeError, isInvokeError, type InvokeContext, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { enqueuedOf, enqueueRequestOf, type EnqueueItem } from "./enqueue-request.js";
import { BoundQueueOperation, ERR_QUEUE_GROUP_INVALID, type OperationResource } from "./queue-operation.js";

interface EnqueueOutput {
  id: string;
  enqueued: boolean;
}

/** Queue.Enqueue — store one message; the store is handed a batch of one. */
class QueueEnqueue implements ResourceInstance<EnqueueItem, EnqueueOutput> {
  constructor(private readonly bound: BoundQueueOperation) {}

  async invoke(item: EnqueueItem, invokeCtx?: InvokeContext): Promise<EnqueueOutput> {
    const store = this.bound.store;
    const request = enqueueRequestOf(
      this.bound.describe,
      item,
      store.settings(),
      this.bound.ctx.traceCarrier(invokeCtx),
    );
    const [outcome] = await this.bound
      .call(() => store.enqueue([request], invokeCtx))
      .catch((err: unknown) => {
        throw withoutBatchIndex(err);
      });
    return {
      id: request.id,
      enqueued: enqueuedOf(this.bound.describe, request.id, outcome),
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

/** A store names the item of the batch a group refusal is about; a single
 *  enqueue has no batch, so the index it was handed is dropped. */
function withoutBatchIndex(err: unknown): unknown {
  if (!isInvokeError(err) || err.code !== ERR_QUEUE_GROUP_INVALID) return err;
  const { index, ...data } = (err.data ?? {}) as Record<string, unknown>;
  return new InvokeError(err.code, err.message, data, { cause: err });
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<QueueEnqueue> {
  return new QueueEnqueue(new BoundQueueOperation("Queue.Enqueue", resource, ctx));
}

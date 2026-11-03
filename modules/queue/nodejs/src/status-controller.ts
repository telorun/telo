import type { CelTimestamp, InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundQueueOperation, MessageReader, storeInconsistent, type OperationResource } from "./queue-operation.js";
import type { MessageState } from "./queue-store-contract.js";

interface StatusOutput {
  id: string;
  state: MessageState | "unknown";
  attempts: number;
  enqueuedAt?: CelTimestamp;
  visibleAt?: CelTimestamp;
  settledAt?: CelTimestamp;
  lastError?: { code: string; message: string };
  reason?: string;
  message?: unknown;
}

/** Queue.Status — one message by id. An id nothing holds is `unknown`. */
class QueueStatus implements ResourceInstance<{ id: string }, StatusOutput> {
  private reader: MessageReader | undefined;

  constructor(private readonly bound: BoundQueueOperation) {}

  async invoke(inputs: { id: string }, invokeCtx?: InvokeContext): Promise<StatusOutput> {
    const store = this.bound.addressableStore;
    const found = await this.bound.call(() => store.get(inputs.id, invokeCtx));
    if (found.status === "absent") return { id: inputs.id, state: "unknown", attempts: 0 };
    if (found.status !== "found") throw storeInconsistent(this.bound.describe, `${JSON.stringify(found)} for a lookup`);
    const stored = found.message;
    this.reader ??= new MessageReader(store.settings(), this.bound.ctx);
    const decoded = this.reader.read(stored.body, stored.generation);
    return {
      id: stored.id,
      state: stored.state,
      attempts: stored.attempts,
      enqueuedAt: stored.enqueuedAt,
      ...(stored.visibleAt === undefined ? {} : { visibleAt: stored.visibleAt }),
      ...(stored.settledAt === undefined ? {} : { settledAt: stored.settledAt }),
      ...(stored.lastError === undefined
        ? {}
        : { lastError: { code: stored.lastError.code, message: stored.lastError.message } }),
      ...(stored.reason === undefined ? {} : { reason: stored.reason }),
      message: decoded.ok ? decoded.message : null,
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<QueueStatus> {
  return new QueueStatus(new BoundQueueOperation("Queue.Status", resource, ctx));
}

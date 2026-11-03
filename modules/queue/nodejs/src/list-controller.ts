import { InvokeError, type InvokeContext, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { encodeListCursor, listCursorTail } from "./list-cursor.js";
import { BoundQueueOperation, storeInconsistent, type OperationResource } from "./queue-operation.js";
import type { ListOutcome, MessageState } from "./queue-store-contract.js";

export const ERR_QUEUE_CURSOR_INVALID = "ERR_QUEUE_CURSOR_INVALID";

interface ListInput {
  state: MessageState;
  limit?: number | bigint;
  cursor?: string;
}

type ListedMessage = Extract<ListOutcome, { status: "page" }>["messages"][number];

interface ListOutput {
  messages: Array<Record<string, unknown>>;
  next?: string;
}

const DEFAULT_LIMIT = 100;

/** Queue.List — a page of one state, oldest first. */
class QueueList implements ResourceInstance<ListInput, ListOutput> {
  constructor(private readonly bound: BoundQueueOperation) {}

  async invoke(inputs: ListInput, invokeCtx?: InvokeContext): Promise<ListOutput> {
    const store = this.bound.addressableStore;
    const after = inputs.cursor === undefined ? undefined : this.tailOf(inputs.cursor, inputs.state);
    const page = await this.bound.call(() =>
      store.list(
        {
          state: inputs.state,
          limit: inputs.limit === undefined ? DEFAULT_LIMIT : Number(inputs.limit),
          ...(after === undefined ? {} : { after }),
        },
        invokeCtx,
      ),
    );
    if (page.status === "cursorInvalid") throw this.cursorInvalid(inputs.state);
    if (page.status !== "page") throw storeInconsistent(this.bound.describe, `${JSON.stringify(page)} for a listing`);
    return {
      messages: page.messages.map(listed),
      ...(page.next === undefined ? {} : { next: encodeListCursor(inputs.state, page.next) }),
    };
  }

  private tailOf(cursor: string, state: MessageState): string {
    const tail = listCursorTail(cursor, state);
    if (tail === undefined) throw this.cursorInvalid(state);
    return tail;
  }

  private cursorInvalid(state: MessageState): InvokeError {
    return new InvokeError(
      ERR_QUEUE_CURSOR_INVALID,
      `${this.bound.describe}: the cursor was not returned by a listing of '${state}' messages on ` +
        `this queue, or the queue can no longer read it. Start again without a cursor.`,
    );
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function listed(message: ListedMessage): Record<string, unknown> {
  return {
    id: message.id,
    state: message.state,
    attempts: message.attempts,
    enqueuedAt: message.enqueuedAt,
    ...(message.visibleAt === undefined ? {} : { visibleAt: message.visibleAt }),
    ...(message.settledAt === undefined ? {} : { settledAt: message.settledAt }),
    ...(message.lastError === undefined
      ? {}
      : { lastError: { code: message.lastError.code, message: message.lastError.message } }),
  };
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<QueueList> {
  return new QueueList(new BoundQueueOperation("Queue.List", resource, ctx));
}

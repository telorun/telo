import {
  InvokeError,
  isCancellationError,
  isInvokeError,
  type InvokeContext,
  type KindRef,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { ERR_CONVERSATION_UNAVAILABLE } from "./conversation-errors.js";
import { isConversationStore, type ConversationStore } from "./conversation-store-contract.js";

export interface OperationResource {
  metadata: { name: string; module?: string };
  store?: ConversationStore | KindRef<ConversationStore>;
}

/** One operation bound to the store its `store` slot names, resolved per call so creation orders against nothing. */
class StoreOperation implements ResourceInstance {
  private readonly describe: string;

  constructor(
    kind: string,
    private readonly resource: OperationResource,
    private readonly ctx: ResourceContext,
    private readonly work: (
      store: ConversationStore,
      inputs: any,
      invokeCtx: InvokeContext | undefined,
    ) => Promise<unknown>,
  ) {
    this.describe = `${kind} "${resource.metadata.name}"`;
  }

  async invoke(inputs: unknown, invokeCtx?: InvokeContext): Promise<unknown> {
    const store = this.ctx.resolveRef(
      this.resource.store,
      isConversationStore,
      () => `${this.describe}: 'store'`,
      "AiConversation.Store",
    );
    try {
      return await this.work(store, inputs, invokeCtx);
    } catch (err) {
      throw storeFailure(this.describe, err);
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

/** A cancellation and a coded error pass through; any other failure is the storage's, raised retryable with the failure as its cause. */
function storeFailure(describe: string, err: unknown): unknown {
  if (isCancellationError(err) || isInvokeError(err)) return err;
  if (err instanceof Error && err.name === "RuntimeError" && typeof (err as { code?: unknown }).code === "string") {
    return err;
  }
  const reason = err instanceof Error ? err.message : String(err);
  return new InvokeError(
    ERR_CONVERSATION_UNAVAILABLE,
    `${describe}: the conversation storage failed — ${reason}`,
    undefined,
    { cause: err },
  );
}

export function operation(
  kind: string,
  run: (store: ConversationStore, inputs: any, invokeCtx: InvokeContext | undefined) => Promise<unknown>,
) {
  return {
    async create(resource: OperationResource, ctx: ResourceContext): Promise<ResourceInstance> {
      return new StoreOperation(kind, resource, ctx, run);
    },
  };
}

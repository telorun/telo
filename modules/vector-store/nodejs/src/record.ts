import type { KindRef, ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { type VectorRecord, type VectorStoreHandle, isVectorStore } from "./store.js";

interface RecordResource {
  metadata: { name: string; module?: string };
  store?: VectorStoreHandle | KindRef<VectorStoreHandle>;
}

interface RecordInputs {
  items: VectorRecord[];
}

class VectorRecordOp implements ResourceInstance<RecordInputs, { ids: string[] }> {
  constructor(
    private readonly resource: RecordResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: RecordInputs): Promise<{ ids: string[] }> {
    if (!inputs || !Array.isArray(inputs.items) || inputs.items.length === 0) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `VectorStore.Record "${this.resource.metadata.name}": 'items' must be a non-empty array.`,
      );
    }
    const store = this.ctx.resolveRef(
      this.resource.store,
      isVectorStore,
      () => `VectorStore.Record "${this.resource.metadata.name}": 'store'`,
      "std/vector-store#Store",
    );
    return store.upsert(inputs.items);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: RecordResource,
  ctx: ResourceContext,
): Promise<VectorRecordOp> {
  return new VectorRecordOp(resource, ctx);
}

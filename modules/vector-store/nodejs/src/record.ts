import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type { VectorRecord, VectorStoreHandle } from "./store.js";
import { resolveVectorStore } from "./store-ref.js";

interface RecordResource {
  metadata: { name: string; module?: string };
  store?: VectorStoreHandle | { name: string; alias?: string };
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
    const store = resolveVectorStore(this.resource.store, this.ctx);
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

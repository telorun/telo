import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type { MetadataFilter, VectorStoreHandle } from "./store.js";
import { resolveVectorStore } from "./store-ref.js";

interface RemovalResource {
  metadata: { name: string; module?: string };
  store?: VectorStoreHandle | { name: string; alias?: string };
}

interface RemovalInputs {
  ids?: string[];
  metadataFilter?: MetadataFilter;
}

class VectorRemovalOp implements ResourceInstance<RemovalInputs, { removed: number }> {
  constructor(
    private readonly resource: RemovalResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: RemovalInputs): Promise<{ removed: number }> {
    const hasIds = Array.isArray(inputs?.ids) && inputs.ids.length > 0;
    const hasFilter = !!inputs?.metadataFilter;
    if (!hasIds && !hasFilter) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `VectorStore.Removal "${this.resource.metadata.name}": provide 'ids' and/or 'metadataFilter'.`,
      );
    }
    const store = resolveVectorStore(this.resource.store, this.ctx);
    return store.delete({ ids: inputs.ids, metadataFilter: inputs.metadataFilter });
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: RemovalResource,
  ctx: ResourceContext,
): Promise<VectorRemovalOp> {
  return new VectorRemovalOp(resource, ctx);
}

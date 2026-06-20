import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type { MetadataFilter, VectorMatch, VectorStoreHandle } from "./store.js";
import { resolveVectorStore } from "./store-ref.js";

interface MatchResource {
  metadata: { name: string; module?: string };
  store?: VectorStoreHandle | { name: string; alias?: string };
  topK?: number;
  includeVectors?: boolean;
}

interface MatchInputs {
  vector: number[];
  metadataFilter?: MetadataFilter;
}

class VectorMatchOp implements ResourceInstance<MatchInputs, { matches: VectorMatch[] }> {
  private readonly topK: number;
  private readonly includeVectors: boolean;

  constructor(
    private readonly resource: MatchResource,
    private readonly ctx: ResourceContext,
  ) {
    this.topK = resource.topK ?? 10;
    this.includeVectors = resource.includeVectors ?? false;
  }

  async invoke(inputs: MatchInputs): Promise<{ matches: VectorMatch[] }> {
    if (!inputs || !Array.isArray(inputs.vector) || inputs.vector.length === 0) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `VectorStore.Match "${this.resource.metadata.name}": 'vector' must be a non-empty array.`,
      );
    }
    const store = resolveVectorStore(this.resource.store, this.ctx);
    return store.query(inputs.vector, {
      topK: this.topK,
      includeVectors: this.includeVectors,
      metadataFilter: inputs.metadataFilter,
    });
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(resource: MatchResource, ctx: ResourceContext): Promise<VectorMatchOp> {
  return new VectorMatchOp(resource, ctx);
}

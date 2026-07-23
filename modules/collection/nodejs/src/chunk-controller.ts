import { InvokeError, type ResourceContext } from "@telorun/sdk";

interface ChunkResource {
  metadata: { name: string };
  collection: unknown;
  size: unknown;
}

/** Splits a collection into consecutive batches of at most `size` elements —
 *  the trailing batch may be shorter. There is no native CEL chunk. */
class Chunk {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: ChunkResource,
  ) {}

  async invoke(inputs: Record<string, unknown>): Promise<{ chunks: unknown[][] }> {
    const call = inputs ?? {};
    const items = this.ctx.expandValue(this.resource.collection, { inputs: call });
    if (!Array.isArray(items)) {
      throw new InvokeError(
        "INVALID_COLLECTION",
        `Collection.Chunk "${this.resource.metadata.name}": collection did not resolve to an array`,
        { value: items },
      );
    }
    const size = Number(this.ctx.expandValue(this.resource.size, { inputs: call }));
    if (!Number.isInteger(size) || size < 1) {
      throw new InvokeError(
        "INVALID_CHUNK_SIZE",
        `Collection.Chunk "${this.resource.metadata.name}": size must be a positive integer, got ${size}`,
        { size },
      );
    }
    const chunks: unknown[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return { chunks };
  }
}

export function register(): void {}

export async function create(resource: ChunkResource, ctx: ResourceContext): Promise<Chunk> {
  return new Chunk(ctx, resource);
}

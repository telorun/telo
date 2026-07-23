import { InvokeError, type ResourceContext } from "@telorun/sdk";
import { keyId } from "./key-identity.js";

interface DistinctResource {
  metadata: { name: string };
  collection: unknown;
  key: Record<string, unknown>;
}

/** Keeps the first element for each distinct CEL key tuple, preserving input
 *  order. Deduplicates by a computed key, which native CEL `distinct()` (scalar
 *  identity only) cannot express. */
class Distinct {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: DistinctResource,
  ) {}

  async invoke(inputs: Record<string, unknown>): Promise<{ items: unknown[] }> {
    const call = inputs ?? {};
    const items = this.ctx.expandValue(this.resource.collection, { inputs: call });
    if (!Array.isArray(items)) {
      throw new InvokeError(
        "INVALID_COLLECTION",
        `Collection.Distinct "${this.resource.metadata.name}": collection did not resolve to an array`,
        { value: items },
      );
    }
    const seen = new Set<string>();
    const out: unknown[] = [];
    items.forEach((item, index) => {
      const key = this.ctx.expandValue(this.resource.key, {
        inputs: call,
        item,
        index,
        items,
      }) as Record<string, unknown>;
      const id = keyId(Object.values(key));
      if (!seen.has(id)) {
        seen.add(id);
        out.push(item);
      }
    });
    return { items: out };
  }
}

export function register(): void {}

export async function create(resource: DistinctResource, ctx: ResourceContext): Promise<Distinct> {
  return new Distinct(ctx, resource);
}

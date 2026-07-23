import { InvokeError, type ResourceContext } from "@telorun/sdk";
import { type SortEntry, sortByEntries } from "./ordering.js";

interface SortResource {
  metadata: { name: string };
  collection: unknown;
  order?: SortEntry[];
}

/** Orders a collection by a list of CEL keys (each ascending or descending),
 *  applied as tie-breakers. Stable: equal elements keep their input order. */
class Sort {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: SortResource,
  ) {}

  async invoke(inputs: Record<string, unknown>): Promise<{ items: unknown[] }> {
    const call = inputs ?? {};
    const items = this.ctx.expandValue(this.resource.collection, { inputs: call });
    if (!Array.isArray(items)) {
      throw new InvokeError(
        "INVALID_COLLECTION",
        `Collection.Sort "${this.resource.metadata.name}": collection did not resolve to an array`,
        { value: items },
      );
    }
    const order = this.resource.order ?? [];
    if (!order.length) return { items: [...items] };
    return {
      items: sortByEntries(items, order, (item, index) =>
        order.map((entry) => this.ctx.expandValue(entry.by, { item, index, items, inputs: call })),
      ),
    };
  }
}

export function register(): void {}

export async function create(resource: SortResource, ctx: ResourceContext): Promise<Sort> {
  return new Sort(ctx, resource);
}

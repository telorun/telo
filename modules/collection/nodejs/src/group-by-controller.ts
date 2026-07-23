import { InvokeError, type ResourceContext } from "@telorun/sdk";
import { keyId } from "./key-identity.js";
import { type SortEntry, sortByEntries } from "./ordering.js";

interface GroupByResource {
  metadata: { name: string };
  collection: unknown;
  key: Record<string, unknown>;
  aggregate?: Record<string, unknown>;
  orderBy?: SortEntry[];
}

type Row = Record<string, unknown>;

/** Partitions `collection` by the tuple of `key` values, reduces each group
 *  through `aggregate` (with `key` / `group` in CEL scope), and returns
 *  `{ rows }` — the key fields merged with the aggregate fields, ordered by
 *  `orderBy`. Pure: reads no I/O, invokes nothing. */
class GroupBy {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: GroupByResource,
  ) {}

  async invoke(inputs: Record<string, unknown>): Promise<{ rows: Row[] }> {
    const call = inputs ?? {};
    const items = this.ctx.expandValue(this.resource.collection, { inputs: call });
    if (!Array.isArray(items)) {
      throw new InvokeError(
        "INVALID_COLLECTION",
        `Collection.GroupBy "${this.resource.metadata.name}": collection did not resolve to an array`,
        { value: items },
      );
    }

    const order: string[] = [];
    const buckets = new Map<string, { key: Row; group: unknown[] }>();
    items.forEach((item, index) => {
      const key = this.ctx.expandValue(this.resource.key, {
        inputs: call,
        item,
        index,
        items,
      }) as Row;
      const id = keyId(Object.values(key));
      let bucket = buckets.get(id);
      if (!bucket) {
        bucket = { key, group: [] };
        buckets.set(id, bucket);
        order.push(id);
      }
      bucket.group.push(item);
    });

    let rows: Row[] = order.map((id) => {
      const { key, group } = buckets.get(id)!;
      const aggregated = this.resource.aggregate
        ? (this.ctx.expandValue(this.resource.aggregate, { inputs: call, key, group }) as Row)
        : {};
      return { ...key, ...aggregated };
    });

    const orderBy = this.resource.orderBy;
    if (orderBy?.length) {
      rows = sortByEntries(rows, orderBy, (row) =>
        orderBy.map((entry) => this.ctx.expandValue(entry.by, { row })),
      );
    }

    return { rows };
  }
}

export function register(): void {}

export async function create(resource: GroupByResource, ctx: ResourceContext): Promise<GroupBy> {
  return new GroupBy(ctx, resource);
}

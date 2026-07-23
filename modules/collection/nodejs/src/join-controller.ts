import { InvokeError, type ResourceContext } from "@telorun/sdk";
import { keyId } from "./key-identity.js";

interface JoinResource {
  metadata: { name: string };
  left: unknown;
  right: unknown;
  on: { left: unknown; right: unknown };
  type?: "inner" | "left";
  select?: Record<string, unknown>;
}

/** Joins two collections on a CEL key from each side. `inner` emits a row per
 *  matched (left, right) pair; `left` also emits unmatched left rows with
 *  `right` bound to null. `select` shapes each output row (defaults to
 *  `{ left, right }`). Not expressible in CEL. */
class Join {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: JoinResource,
  ) {}

  private array(field: "left" | "right", inputs: Record<string, unknown>): unknown[] {
    const value = this.ctx.expandValue(this.resource[field], { inputs });
    if (!Array.isArray(value)) {
      throw new InvokeError(
        "INVALID_COLLECTION",
        `Collection.Join "${this.resource.metadata.name}": ${field} did not resolve to an array`,
        { value },
      );
    }
    return value;
  }

  async invoke(inputs: Record<string, unknown>): Promise<{ rows: unknown[] }> {
    const call = inputs ?? {};
    const left = this.array("left", call);
    const right = this.array("right", call);

    const index = new Map<string, unknown[]>();
    right.forEach((item, i) => {
      const id = keyId([
        this.ctx.expandValue(this.resource.on.right, {
          inputs: call,
          right: item,
          index: i,
          items: right,
        }),
      ]);
      const bucket = index.get(id);
      if (bucket) bucket.push(item);
      else index.set(id, [item]);
    });

    const leftJoin = this.resource.type === "left";
    const rows: unknown[] = [];
    left.forEach((item, i) => {
      const id = keyId([
        this.ctx.expandValue(this.resource.on.left, {
          inputs: call,
          left: item,
          index: i,
          items: left,
        }),
      ]);
      const matches = index.get(id);
      if (!matches || matches.length === 0) {
        if (leftJoin) rows.push(this.row(call, item, null));
        return;
      }
      for (const match of matches) rows.push(this.row(call, item, match));
    });

    return { rows };
  }

  private row(inputs: Record<string, unknown>, left: unknown, right: unknown): unknown {
    return this.resource.select
      ? this.ctx.expandValue(this.resource.select, { inputs, left, right })
      : { left, right };
  }
}

export function register(): void {}

export async function create(resource: JoinResource, ctx: ResourceContext): Promise<Join> {
  return new Join(ctx, resource);
}

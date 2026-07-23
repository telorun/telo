import { InvokeError, type ResourceContext } from "@telorun/sdk";

interface SummarizeResource {
  metadata: { name: string };
  collection: unknown;
  aggregate?: Record<string, unknown>;
}

/** Reduces a whole collection to a single summary object — GroupBy with one
 *  implicit group. The CEL `aggregate` map sees `group` (the full collection). */
class Summarize {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: SummarizeResource,
  ) {}

  async invoke(inputs: Record<string, unknown>): Promise<{ summary: Record<string, unknown> }> {
    const call = inputs ?? {};
    const items = this.ctx.expandValue(this.resource.collection, { inputs: call });
    if (!Array.isArray(items)) {
      throw new InvokeError(
        "INVALID_COLLECTION",
        `Collection.Summarize "${this.resource.metadata.name}": collection did not resolve to an array`,
        { value: items },
      );
    }
    const summary = this.resource.aggregate
      ? (this.ctx.expandValue(this.resource.aggregate, { inputs: call, group: items }) as Record<
          string,
          unknown
        >)
      : {};
    return { summary };
  }
}

export function register(): void {}

export async function create(resource: SummarizeResource, ctx: ResourceContext): Promise<Summarize> {
  return new Summarize(ctx, resource);
}

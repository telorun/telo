import { InvokeError, type ResourceContext } from "@telorun/sdk";

interface FoldResource {
  metadata: { name: string };
  collection: unknown;
  initial: unknown;
  while?: unknown;
  accumulate: unknown;
  value: unknown;
}

/** Accumulates a collection into one value: the `accumulate` CEL expression
 *  produces the next accumulator once per element, `while` may stop the run
 *  early, and `value` projects the finished state. Pure — nothing is dispatched,
 *  and the iteration count is bounded by the collection's length. */
class Fold {
  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: FoldResource,
  ) {}

  async invoke(inputs: Record<string, unknown>): Promise<unknown> {
    const call = inputs ?? {};
    const items = this.ctx.expandValue(this.resource.collection, { inputs: call });
    if (!Array.isArray(items)) {
      throw new InvokeError(
        "INVALID_COLLECTION",
        `Collection.Fold "${this.resource.metadata.name}": collection did not resolve to an array`,
        { value: items },
      );
    }

    let acc = this.ctx.expandValue(this.resource.initial, { inputs: call });

    for (const [index, item] of items.entries()) {
      const scope = { inputs: call, acc, item, index, items };
      // Guarded BEFORE the element, so a fold that stops "once the balance is
      // exhausted" never consumes the element that would overdraw it.
      if (!this.shouldContinue(scope, index)) break;
      acc = this.ctx.expandValue(this.resource.accumulate, scope);
    }

    return this.ctx.expandValue(this.resource.value, { inputs: call, acc, items });
  }

  /** A `while` must evaluate to a real boolean — a truthy string or number is an
   *  authoring mistake, not a decision to keep folding. */
  private shouldContinue(scope: Record<string, unknown>, index: number): boolean {
    if (this.resource.while === undefined) return true;
    const verdict = this.ctx.expandValue(this.resource.while, scope);
    if (typeof verdict !== "boolean") {
      throw new InvokeError(
        "ERR_INVALID_PREDICATE",
        `Collection.Fold "${this.resource.metadata.name}": \`while\` evaluated to ` +
          `${typeof verdict} at element ${index}, expected a boolean.`,
      );
    }
    return verdict;
  }
}

export function register(): void {}

export async function create(resource: FoldResource, ctx: ResourceContext): Promise<Fold> {
  // A `value:` key written blank parses to null, which the schema cannot reject
  // (a compiled CEL node is indistinguishable from null there). Caught at load
  // rather than left to return null from every call.
  if (resource.value === null || resource.value === undefined) {
    throw new InvokeError(
      "INVALID_VALUE",
      `Collection.Fold "${resource.metadata.name}": \`value\` is empty. It is the fold's ` +
        `result — write \`!cel "acc"\` to return the accumulator itself.`,
    );
  }
  return new Fold(ctx, resource);
}

import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";

interface CollectResource {
  metadata: { name: string; module?: string };
}

interface CollectInputs {
  input: AsyncIterable<unknown>;
}

interface CollectOutputs {
  items: unknown[];
}

/**
 * Terminal stream sink — the inverse of Stream.Of. Consumes `input` fully and
 * returns every item as `items`, in order. Draining drives the producer's side
 * effects (so it "runs" an upstream agent / pipeline); the result materializes the
 * finite stream for inspection, assertion, or aggregation in CEL. Value-agnostic and
 * buffered — bounded by the stream's length.
 */
class StreamCollect implements ResourceInstance<CollectInputs, CollectOutputs> {
  constructor(private readonly resource: CollectResource) {}

  async invoke(inputs: CollectInputs): Promise<CollectOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (
      !input ||
      typeof (input as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function"
    ) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Stream.Collect "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    const items: unknown[] = [];
    for await (const item of input) items.push(item);
    return { items };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: CollectResource,
  _ctx: ResourceContext,
): Promise<StreamCollect> {
  return new StreamCollect(resource);
}

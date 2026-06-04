import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { Stream } from "@telorun/sdk";

interface OfResource {
  metadata: { name: string; module?: string };
  items?: unknown[];
}

interface OfOutputs {
  output: Stream<unknown>;
}

/**
 * Literal stream source. Emits the declared `items` array as a stream, in
 * order. Value-agnostic — items pass through verbatim, so the element type is
 * whatever the manifest declares (string, object, number). The output is an
 * opaque stream; downstream consumers validate element shapes at runtime.
 */
class StreamOf implements ResourceInstance<Record<string, unknown>, OfOutputs> {
  constructor(private readonly resource: OfResource) {}

  async invoke(): Promise<OfOutputs> {
    const items = Array.isArray(this.resource.items) ? this.resource.items : [];
    return { output: new Stream(emit(items)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* emit(items: unknown[]): AsyncIterable<unknown> {
  for (const item of items) {
    yield item;
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: OfResource,
  _ctx: ResourceContext,
): Promise<StreamOf> {
  return new StreamOf(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};

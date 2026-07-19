import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { Stream } from "@telorun/sdk";

interface OfResource {
  metadata: { name: string; module?: string };
  items?: unknown[];
}

interface OfInputs {
  items?: unknown[];
}

interface OfOutputs {
  output: Stream<unknown>;
}

/**
 * Stream source. Emits an `items` array as a stream, in order. Items come from
 * the invoke inputs when provided (values computed at request time), otherwise
 * from the statically-declared resource field; neither present yields an empty
 * stream. Value-agnostic — items pass through verbatim, so the element type is
 * whatever the manifest declares (string, object, number). The output is an
 * opaque stream; downstream consumers validate element shapes at runtime.
 */
class StreamOf implements ResourceInstance<OfInputs, OfOutputs> {
  constructor(private readonly resource: OfResource) {}

  async invoke(inputs?: OfInputs): Promise<OfOutputs> {
    const runtime = inputs?.items;
    const items = Array.isArray(runtime)
      ? runtime
      : Array.isArray(this.resource.items)
        ? this.resource.items
        : [];
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


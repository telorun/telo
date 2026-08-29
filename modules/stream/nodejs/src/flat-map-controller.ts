import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";
import { requireStream } from "./stream-input.js";

interface FlatMapResource {
  metadata: { name: string; module?: string };
  values?: unknown;
}

interface FlatMapInputs {
  input?: unknown;
}

interface FlatMapOutputs {
  output: Stream<unknown>;
}

/**
 * One element in, any number out — including none.
 *
 * This is what makes a stream's cardinality changeable at all, and both
 * directions matter on a real protocol: one wire frame carries several logical
 * parts, and a keep-alive or a terminator carries none. Expressing "drop this"
 * as an empty list is what removes the need for a separate filter stage and for
 * a sentinel value meaning nothing.
 */
class StreamFlatMap implements ResourceInstance<FlatMapInputs, FlatMapOutputs> {
  constructor(
    private readonly resource: FlatMapResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: FlatMapInputs): Promise<FlatMapOutputs> {
    const name = this.resource.metadata.name;
    const input = requireStream(inputs?.input, "Stream.FlatMap", name);
    if (this.resource.values === undefined) {
      throw new InvokeError(
        "ERR_INVALID_VALUE",
        `Stream.FlatMap "${name}": 'values' was written blank. A key with no value ` +
          `parses to null, which the schema cannot tell from a CEL node.`,
      );
    }
    return { output: new Stream(flatMap(input, this.resource.values, this.ctx, inputs, name)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* flatMap(
  input: AsyncIterable<unknown>,
  values: unknown,
  ctx: ResourceContext,
  call: FlatMapInputs,
  name: string,
): AsyncIterable<unknown> {
  let index = 0;
  for await (const item of input) {
    const produced = ctx.expandValue(values, { inputs: call, item, index });
    if (!Array.isArray(produced)) {
      // Refused rather than wrapped. Emitting a non-array as a single element
      // would make `values` mean two things — a list to flatten, and a value to
      // pass — kept apart only by what an expression happened to return, so a
      // list-valued element would silently flatten one call and not the next.
      throw new InvokeError(
        "ERR_INVALID_VALUE",
        `Stream.FlatMap "${name}": 'values' must evaluate to an array; ` +
          `element ${index} produced ${produced === null ? "null" : typeof produced}. ` +
          `Emit [] to drop an element.`,
      );
    }
    for (const value of produced) yield value;
    index++;
  }
}

export function register(): void {}

export async function create(
  resource: FlatMapResource,
  ctx: ResourceContext,
): Promise<StreamFlatMap> {
  return new StreamFlatMap(resource, ctx);
}

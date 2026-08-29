import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";
import { requireStream } from "./stream-input.js";

interface MapResource {
  metadata: { name: string; module?: string };
  value?: unknown;
}

interface MapInputs {
  input?: unknown;
}

interface MapOutputs {
  output: Stream<unknown>;
}

/**
 * One element in, one element out, lazily.
 *
 * The work happens as the consumer pulls, never in `invoke()`: a transform that
 * drained its source to build a result would defeat the whole point of the
 * stage, and would make a token stream arrive all at once at the end.
 *
 * Abandonment needs no code here. A consumer that stops draining causes
 * `for await` to call `return()` on this generator, which — being suspended at
 * a `yield` inside its own `for await` — propagates that to its source, and so
 * on to the transport. Every stage is a pass-through by construction rather
 * than by remembering to be one.
 */
class StreamMap implements ResourceInstance<MapInputs, MapOutputs> {
  constructor(
    private readonly resource: MapResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: MapInputs): Promise<MapOutputs> {
    const name = this.resource.metadata.name;
    const input = requireStream(inputs?.input, "Stream.Map", name);
    if (this.resource.value === undefined) {
      throw new InvokeError(
        "ERR_INVALID_VALUE",
        `Stream.Map "${name}": 'value' was written blank. A key with no value parses ` +
          `to null, which the schema cannot tell from a CEL node.`,
      );
    }
    return { output: new Stream(map(input, this.resource.value, this.ctx, inputs)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* map(
  input: AsyncIterable<unknown>,
  value: unknown,
  ctx: ResourceContext,
  call: MapInputs,
): AsyncIterable<unknown> {
  let index = 0;
  for await (const item of input) {
    yield ctx.expandValue(value, { inputs: call, item, index });
    index++;
  }
}

export function register(): void {}

export async function create(
  resource: MapResource,
  ctx: ResourceContext,
): Promise<StreamMap> {
  return new StreamMap(resource, ctx);
}

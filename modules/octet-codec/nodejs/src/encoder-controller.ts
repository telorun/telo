import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";

interface EncoderResource {
  metadata: { name: string; module?: string };
}

interface EncoderInputs {
  input: AsyncIterable<unknown>;
}

interface EncoderOutputs {
  output: Stream<Uint8Array>;
}

/**
 * Raw byte pass-through encoder. Accepts only Uint8Array items (Node Buffer is
 * a subclass and works). Other shapes throw at runtime.
 *
 * Mid-stream errors propagate up to the consumer — no in-band error frame for
 * raw bytes (there's no envelope to carry one).
 */
class OctetEncoder implements ResourceInstance<EncoderInputs, EncoderOutputs> {
  constructor(private readonly resource: EncoderResource) {}

  async invoke(inputs: EncoderInputs): Promise<EncoderOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Octet.Encoder "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    return { output: new Stream(encode(input, name)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* encode(
  input: AsyncIterable<unknown>,
  name: string,
): AsyncIterable<Uint8Array> {
  for await (const item of input) {
    if (item instanceof Uint8Array) {
      yield item;
      continue;
    }
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `Octet.Encoder "${name}": items must be Uint8Array; got ${typeof item}.`,
    );
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: EncoderResource,
  _ctx: ResourceContext,
): Promise<OctetEncoder> {
  return new OctetEncoder(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};

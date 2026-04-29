import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";

interface DecoderResource {
  metadata: { name: string; module?: string };
}

interface DecoderInputs {
  input: AsyncIterable<unknown>;
}

interface DecoderOutputs {
  bytes: Uint8Array;
}

/**
 * Raw-bytes decoder. Drains a `Stream<Uint8Array>` and returns a single
 * concatenated `Uint8Array`. Symmetric counterpart to `Octet.Encoder` (which
 * is byte-passthrough): use `Decoder` when you want one buffered blob,
 * `Encoder` when you want streaming pass-through.
 *
 * Accepts only `Uint8Array` items. Other shapes throw at runtime.
 */
class OctetDecoder implements ResourceInstance<DecoderInputs, DecoderOutputs> {
  constructor(private readonly resource: DecoderResource) {}

  async invoke(inputs: DecoderInputs): Promise<DecoderOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Octet.Decoder "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        continue;
      }
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Octet.Decoder "${name}": items must be Uint8Array; got ${typeof chunk}.`,
      );
    }
    return { bytes: Buffer.concat(chunks) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: DecoderResource,
  _ctx: ResourceContext,
): Promise<OctetDecoder> {
  return new OctetDecoder(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};

import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";

interface DecoderResource {
  metadata: { name: string; module?: string };
}

interface DecoderInputs {
  input: AsyncIterable<unknown>;
}

interface DecoderOutputs {
  text: string;
}

/**
 * Plain-text decoder. Drains a byte stream into a single UTF-8 string.
 * Accepts `Uint8Array` (Buffer is a subtype) and bare `string` items as a
 * pass-through convenience. Other shapes throw at runtime.
 *
 * Buffer-mode: collects the whole input before returning. For streaming
 * scenarios where you want each line / record as it arrives, use
 * `Ndjson.Decoder` (line-buffered) or `Sse.Decoder` (frame-buffered) once
 * those ship.
 */
class PlainTextDecoder implements ResourceInstance<DecoderInputs, DecoderOutputs> {
  constructor(private readonly resource: DecoderResource) {}

  async invoke(inputs: DecoderInputs): Promise<DecoderOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `PlainText.Decoder "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        continue;
      }
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk, "utf8"));
        continue;
      }
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `PlainText.Decoder "${name}": items must be Uint8Array or string; got ${typeof chunk}.`,
      );
    }
    return { text: Buffer.concat(chunks).toString("utf8") };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: DecoderResource,
  _ctx: ResourceContext,
): Promise<PlainTextDecoder> {
  return new PlainTextDecoder(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};

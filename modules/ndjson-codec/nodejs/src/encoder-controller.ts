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
 * NDJSON encoder. Each item becomes one line: `JSON.stringify(item) + "\n"`.
 *
 * Mid-stream error: if the upstream iterable throws, emit a final error frame
 * `{"type":"error","error":{"message":"..."}}\n` then end. The consumer sees
 * a well-formed NDJSON stream that terminates with an error record — no
 * dangling exception across the wire.
 */
class NdjsonEncoder implements ResourceInstance<EncoderInputs, EncoderOutputs> {
  constructor(private readonly resource: EncoderResource) {}

  async invoke(inputs: EncoderInputs): Promise<EncoderOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Ndjson.Encoder "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    return { output: new Stream(encode(input)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* encode(input: AsyncIterable<unknown>): AsyncIterable<Uint8Array> {
  try {
    for await (const item of input) {
      yield Buffer.from(JSON.stringify(item) + "\n", "utf8");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield Buffer.from(JSON.stringify({ type: "error", error: { message } }) + "\n", "utf8");
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: EncoderResource,
  _ctx: ResourceContext,
): Promise<NdjsonEncoder> {
  return new NdjsonEncoder(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};

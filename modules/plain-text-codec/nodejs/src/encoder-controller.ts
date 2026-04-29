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
 * Plain-text encoder. Accepts:
 *   - {delta: string} — the AI streaming shape; UTF-8 encodes the delta
 *   - bare strings — UTF-8 encoded directly
 *   - Uint8Array — passed through unchanged (Buffer is a subclass)
 *   - {type: "finish", ...} — silently dropped (no representation in plain text)
 *   - {type: "error", error: {message}} — throws (consumer aborts the transport)
 *
 * Other shapes throw at runtime.
 */
class PlainTextEncoder implements ResourceInstance<EncoderInputs, EncoderOutputs> {
  constructor(private readonly resource: EncoderResource) {}

  async invoke(inputs: EncoderInputs): Promise<EncoderOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `PlainText.Encoder "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    return { output: new Stream(encode(input, name)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* encode(input: AsyncIterable<unknown>, name: string): AsyncIterable<Uint8Array> {
  for await (const item of input) {
    if (item instanceof Uint8Array) {
      yield item;
      continue;
    }
    if (typeof item === "string") {
      yield Buffer.from(item, "utf8");
      continue;
    }
    if (item && typeof item === "object" && typeof (item as any).delta === "string") {
      yield Buffer.from((item as { delta: string }).delta, "utf8");
      continue;
    }
    if (item && typeof item === "object" && typeof (item as any).type === "string") {
      const type = (item as { type: string }).type;
      if (type === "finish") continue;
      if (type === "error") {
        const err = (item as { error?: { message?: string } }).error;
        throw new Error(err?.message ?? `PlainText.Encoder "${name}": stream error`);
      }
    }
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `PlainText.Encoder "${name}": unsupported item shape — expected {delta: string} | string | Uint8Array.`,
    );
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: EncoderResource,
  _ctx: ResourceContext,
): Promise<PlainTextEncoder> {
  return new PlainTextEncoder(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};

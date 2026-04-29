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
 * Server-Sent Events encoder. Each item becomes one frame:
 *   `event: <type>\ndata: <json>\n\n`
 *
 * Item shape: `{type: string, ...rest}` — the `type` becomes the SSE event,
 * the rest of the object becomes the JSON-encoded data payload. Bare strings
 * are framed as a generic `message` event whose data is the JSON-encoded
 * string (i.e. quoted, with backslash escapes for embedded newlines / quotes).
 * This is intentional: SSE `data:` lines must not contain literal newlines, so
 * JSON encoding is the safe default. Authors who need raw-text-on-wire should
 * use `PlainText.Encoder` instead.
 *
 * Mid-stream error: if the upstream iterable throws, emit a final
 * `event: error\ndata: {"message":"..."}\n\n` then end.
 */
class SseEncoder implements ResourceInstance<EncoderInputs, EncoderOutputs> {
  constructor(private readonly resource: EncoderResource) {}

  async invoke(inputs: EncoderInputs): Promise<EncoderOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Sse.Encoder "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    return { output: new Stream(encode(input, name)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* encode(input: AsyncIterable<unknown>, name: string): AsyncIterable<Uint8Array> {
  try {
    for await (const item of input) {
      yield Buffer.from(formatFrame(item, name), "utf8");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield Buffer.from(`event: error\ndata: ${JSON.stringify({ message })}\n\n`, "utf8");
  }
}

function formatFrame(item: unknown, name: string): string {
  if (typeof item === "string") {
    return `event: message\ndata: ${JSON.stringify(item)}\n\n`;
  }
  if (!item || typeof item !== "object" || typeof (item as any).type !== "string") {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `Sse.Encoder "${name}": items must be {type: string, ...} or string; got ${typeof item}.`,
    );
  }
  const { type, ...rest } = item as { type: string; [k: string]: unknown };
  return `event: ${type}\ndata: ${JSON.stringify(rest)}\n\n`;
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: EncoderResource,
  _ctx: ResourceContext,
): Promise<SseEncoder> {
  return new SseEncoder(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};

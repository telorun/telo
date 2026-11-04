import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";
import { sseFrame } from "./sse-frame.js";

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
 * Server-Sent Events encoder. Each item is an `SseCodec.Frame` and becomes one
 * frame, written by `sseFrame`; an item that is not a frame fails the stream.
 *
 * Mid-stream error: if the upstream iterable throws, emit a final
 * `event: error\ndata: {"message":"..."}\n\n` then end.
 */
class SseEncoder implements ResourceInstance<EncoderInputs, EncoderOutputs> {
  constructor(
    private readonly resource: EncoderResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: EncoderInputs): Promise<EncoderOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Sse.Encoder "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    return { output: new Stream(encode(input, name, this.ctx)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* encode(
  input: AsyncIterable<unknown>,
  name: string,
  ctx: ResourceContext,
): AsyncIterable<Uint8Array> {
  try {
    for await (const item of input) {
      yield Buffer.from(sseFrame(item, `Sse.Encoder "${name}"`), "utf8");
    }
  } catch (err) {
    // The frame tells the client, and nothing else does: the stream has already
    // been handed to the transport, so the failure never reaches the caller and
    // the response still completes 200. Server-side this is the only report.
    ctx.log.error("The stream failed or held a value that is not a frame; ended with an error frame", undefined, {
      error: err,
    });
    const message = err instanceof Error ? err.message : String(err);
    // The CODE is carried when the error has one: a stream now fails by
    // rejecting, so this frame is all a client gets, and a bare message is not
    // something it can branch on.
    // Narrowed to an InvokeError: a Node system code (`ECONNRESET`, `ABORT_ERR`)
    // is not a Telo code, and forwarding one as `code` would have a client
    // branch on a value that means something else entirely.
    const code = err instanceof InvokeError ? err.code : undefined;
    const payload = { message, ...(code === undefined ? {} : { code }) };
    yield Buffer.from(`event: error\ndata: ${JSON.stringify(payload)}\n\n`, "utf8");
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: EncoderResource,
  ctx: ResourceContext,
): Promise<SseEncoder> {
  return new SseEncoder(resource, ctx);
}


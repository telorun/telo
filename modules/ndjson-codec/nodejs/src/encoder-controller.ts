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
        `Ndjson.Encoder "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    return { output: new Stream(encode(input, this.ctx)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* encode(
  input: AsyncIterable<unknown>,
  ctx: ResourceContext,
): AsyncIterable<Uint8Array> {
  try {
    for await (const item of input) {
      yield Buffer.from(JSON.stringify(item) + "\n", "utf8");
    }
  } catch (err) {
    // The frame tells the client, and nothing else does: the stream has already
    // been handed to the transport, so the failure never reaches the caller and
    // the response still completes 200. Server-side this log is the only report.
    ctx.log.error("Upstream failed mid-stream; emitted a terminal error record", undefined, {
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
    yield Buffer.from(
      JSON.stringify({
        type: "error",
        error: { message, ...(code === undefined ? {} : { code }) },
      }) + "\n",
      "utf8",
    );
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: EncoderResource,
  ctx: ResourceContext,
): Promise<NdjsonEncoder> {
  return new NdjsonEncoder(resource, ctx);
}


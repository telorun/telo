import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
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
 * Gzip encoder. Pipes a `Stream<Uint8Array>` through `zlib.createGzip()` and
 * yields the gzip-compressed byte chunks as another stream. Symmetric
 * counterpart to `Gzip.Decoder`.
 *
 * Accepts only `Uint8Array` items. Other shapes throw at runtime.
 */
class GzipEncoder implements ResourceInstance<EncoderInputs, EncoderOutputs> {
  constructor(private readonly resource: EncoderResource) {}

  async invoke(inputs: EncoderInputs): Promise<EncoderOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Gzip.Encoder "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    return { output: new Stream(gzip(input, name)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* gzip(
  source: AsyncIterable<unknown>,
  name: string,
): AsyncIterable<Uint8Array> {
  const gz = createGzip();
  const src = Readable.from(validateBytes(source, name));
  src.on("error", (err) => gz.destroy(err));
  src.pipe(gz);
  try {
    for await (const chunk of gz) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as Buffer);
    }
  } finally {
    // `.pipe` doesn't tear down the source when the destination errors or the
    // consumer stops early — destroy it so the upstream generator's
    // return()/finally runs (matters once a real file/socket sits upstream).
    src.destroy();
  }
}

async function* validateBytes(
  source: AsyncIterable<unknown>,
  name: string,
): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    if (chunk instanceof Uint8Array) {
      yield chunk;
      continue;
    }
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `Gzip.Encoder "${name}": items must be Uint8Array; got ${typeof chunk}.`,
    );
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: EncoderResource,
  _ctx: ResourceContext,
): Promise<GzipEncoder> {
  return new GzipEncoder(resource);
}


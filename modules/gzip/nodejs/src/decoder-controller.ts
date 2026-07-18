import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";

interface DecoderResource {
  metadata: { name: string; module?: string };
}

interface DecoderInputs {
  input: AsyncIterable<unknown>;
}

interface DecoderOutputs {
  output: Stream<Uint8Array>;
}

/**
 * Gzip decoder. Pipes a `Stream<Uint8Array>` of gzip-compressed bytes through
 * `zlib.createGunzip()` and yields the decompressed byte chunks as another
 * stream. The output is lazy — decompression runs as the consumer iterates.
 *
 * Accepts only `Uint8Array` items. Other shapes throw at runtime.
 */
class GzipDecoder implements ResourceInstance<DecoderInputs, DecoderOutputs> {
  constructor(private readonly resource: DecoderResource) {}

  async invoke(inputs: DecoderInputs): Promise<DecoderOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Gzip.Decoder "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    return { output: new Stream(gunzip(input, name)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* gunzip(
  source: AsyncIterable<unknown>,
  name: string,
): AsyncIterable<Uint8Array> {
  const gz = createGunzip();
  const src = Readable.from(validateBytes(source, name));
  // `.pipe` does not forward source errors to the destination — forward
  // explicitly so a bad upstream chunk rejects the consumer's iteration
  // instead of hanging the gunzip transform.
  src.on("error", (err) => gz.destroy(err));
  src.pipe(gz);
  try {
    for await (const chunk of gz) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as Buffer);
    }
  } finally {
    // `.pipe` also doesn't tear down the source when the destination errors or
    // the consumer stops early — destroy it so the upstream generator's
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
      `Gzip.Decoder "${name}": items must be Uint8Array; got ${typeof chunk}.`,
    );
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: DecoderResource,
  _ctx: ResourceContext,
): Promise<GzipDecoder> {
  return new GzipDecoder(resource);
}


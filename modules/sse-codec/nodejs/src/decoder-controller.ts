import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";
import { readSseRecords, type SseRecord } from "./sse-records.js";

interface DecoderResource {
  metadata: { name: string; module?: string };
}

interface DecoderInputs {
  input?: unknown;
}

interface DecoderOutputs {
  records: Stream<SseRecord>;
}

/**
 * Server-Sent Events decoder — byte chunks in, one record per frame out.
 *
 * Streaming rather than collecting: the whole point of the wire format is that
 * a frame is usable the moment it arrives, and a decoder that buffered to the
 * end would make every SSE consumer wait for the response to finish. So this
 * emits as it parses, and stays a `Codec.Decoder` whose `outputType` is another
 * stream — which is the variation the abstract leaves open.
 *
 * `data` is handed over as TEXT, not parsed. SSE says nothing about what a
 * payload is, and a stream that carries JSON frames routinely also carries a
 * sentinel that is not JSON (`data: [DONE]`), so parsing here would fail on the
 * one frame that says the stream is over. The consumer decides, per frame.
 */
class SseDecoder implements ResourceInstance<DecoderInputs, DecoderOutputs> {
  constructor(private readonly resource: DecoderResource) {}

  async invoke(inputs: DecoderInputs): Promise<DecoderOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (
      !input ||
      typeof (input as Record<symbol, unknown>)[Symbol.asyncIterator] !== "function"
    ) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Sse.Decoder "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    return {
      records: new Stream(readSseRecords(input as AsyncIterable<unknown>, "Sse.Decoder")),
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: DecoderResource,
  _ctx: ResourceContext,
): Promise<SseDecoder> {
  return new SseDecoder(resource);
}

import type { ControllerContext, Logger, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { releaseUnread } from "./input-release.js";
import { boundaryOf, concat } from "./multipart-framing.js";
import { limitInput, readParts } from "./multipart-reading.js";

interface DecoderInputs {
  input: AsyncIterable<unknown>;
  contentType: string;
  maxPartBytes?: unknown;
  maxParts?: unknown;
  maxTotalBytes?: unknown;
}

interface DecodedPart {
  content: Uint8Array;
  contentType?: string;
  name?: string;
  filename?: string;
  headers: Record<string, string>;
}

interface DecoderOutputs {
  parts: DecodedPart[];
}

const WHO = "Multipart.Decoder";
const DEFAULT_MAX_PART_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PARTS = 1000;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/**
 * Splits a received multipart payload back into its parts.
 *
 * THE BOUNDARY COMES FROM THE MEDIA TYPE, never from the bytes: nothing in a
 * multipart body identifies where parts begin without it, so a Content-Type with
 * no `boundary=` parameter is an error rather than a payload with zero parts —
 * the two are indistinguishable to a caller otherwise.
 *
 * Parts are returned as a LIST of buffered parts rather than a stream of them:
 * they become ordinary values, at the price of holding each one whole. Three
 * limits keep that bounded, each with a default — one part's content, the number
 * of parts, and every byte read — so the payload is refused on the chunk that
 * crosses one rather than collected first. `Multipart.Reader` is the incremental
 * counterpart, and reads the same framing through the same code.
 *
 * The input is released on every refusal, a missing boundary included, where
 * nothing of it was read.
 */
class MultipartDecoder implements ResourceInstance<DecoderInputs, DecoderOutputs> {
  constructor(private readonly log: Logger) {}

  async invoke(inputs: DecoderInputs): Promise<DecoderOutputs> {
    let boundary: string;
    try {
      boundary = boundaryOf(inputs?.contentType, WHO);
    } catch (err) {
      await releaseUnread(inputs?.input, WHO, this.log);
      throw err;
    }
    const limits = {
      maxPartBytes: limitInput(inputs.maxPartBytes) ?? DEFAULT_MAX_PART_BYTES,
      maxParts: limitInput(inputs.maxParts) ?? DEFAULT_MAX_PARTS,
      maxTotalBytes: limitInput(inputs.maxTotalBytes) ?? DEFAULT_MAX_TOTAL_BYTES,
    };
    const parts: DecodedPart[] = [];
    for await (const { content, ...part } of readParts(inputs.input, boundary, limits, WHO)) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of content) chunks.push(chunk);
      parts.push({ content: concat(chunks), ...part });
    }
    return { parts };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  _resource: Record<string, unknown>,
  ctx: ResourceContext,
): Promise<MultipartDecoder> {
  return new MultipartDecoder(ctx.log);
}

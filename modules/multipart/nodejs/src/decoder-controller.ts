import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  asBytes,
  boundaryOf,
  concat,
  dispositionFields,
  findHeaderEnd,
  indexOf,
  parseHeaders,
} from "./multipart-framing.js";

interface DecoderInputs {
  input: AsyncIterable<unknown>;
  contentType: string;
  maxPartBytes?: number;
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

/**
 * Splits a received multipart payload back into its parts.
 *
 * THE BOUNDARY COMES FROM THE MEDIA TYPE, never from the bytes: nothing in a
 * multipart body identifies where parts begin without it, so a Content-Type with
 * no `boundary=` parameter is an error rather than a payload with zero parts —
 * the two are indistinguishable to a caller otherwise.
 *
 * Parts are returned as a LIST of buffered parts rather than a stream of them.
 * A part is bytes, and returning a stream-of-streams would make consuming them
 * out of order a use-after-free: the underlying source is single-pass, so a
 * caller holding part 2 while reading part 3 would read nothing. `maxPartBytes`
 * is what keeps that buffering bounded — an unbounded payload would otherwise be
 * an unbounded allocation. `Multipart.Reader` is the unbounded counterpart.
 */
class MultipartDecoder implements ResourceInstance<DecoderInputs, DecoderOutputs> {
  async invoke(inputs: DecoderInputs): Promise<DecoderOutputs> {
    const boundary = boundaryOf(inputs?.contentType, WHO);
    const limit = inputs?.maxPartBytes ?? DEFAULT_MAX_PART_BYTES;
    const body = await collect(inputs.input, limit);
    return { parts: split(body, boundary, limit) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function collect(input: AsyncIterable<unknown>, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = asBytes(chunk, WHO);
    total += bytes.length;
    // Bounded against the WHOLE payload as well as each part: a single part under
    // the limit says nothing about a payload of ten thousand of them.
    if (total > limit) {
      throw new Error(
        `${WHO}: payload exceeds maxPartBytes (${limit}) before any part was complete.`,
      );
    }
    chunks.push(bytes);
  }
  return concat(chunks);
}

function split(body: Uint8Array, boundary: string, limit: number): DecodedPart[] {
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const parts: DecodedPart[] = [];

  let cursor = indexOf(body, delimiter, 0);
  if (cursor < 0) {
    throw new Error(`${WHO}: boundary '${boundary}' does not occur in the payload.`);
  }
  while (cursor >= 0) {
    let start = cursor + delimiter.length;
    // `--` after the delimiter is the closing one: everything after it is epilogue.
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    // Skip the CRLF that ends the delimiter line.
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    else if (body[start] === 0x0a) start += 1;

    const next = indexOf(body, delimiter, start);
    if (next < 0) {
      throw new Error(`${WHO}: the payload ends without a closing boundary — it is truncated.`);
    }
    // The CRLF immediately before the next delimiter belongs to the framing, not
    // to the part; keeping it appends two stray bytes to every part's content.
    let end = next;
    if (body[end - 1] === 0x0a) end -= 1;
    if (body[end - 1] === 0x0d) end -= 1;

    parts.push(readPart(body.subarray(start, end), limit));
    cursor = next;
  }
  return parts;
}

function readPart(section: Uint8Array, limit: number): DecodedPart {
  const split = findHeaderEnd(section);
  if (!split) {
    throw new Error(`${WHO}: a part has no blank line separating headers from content.`);
  }
  const headers = parseHeaders(new TextDecoder().decode(section.subarray(0, split.headerEnd)));
  const content = section.subarray(split.contentStart);
  if (content.length > limit) {
    throw new Error(`${WHO}: a part exceeds maxPartBytes (${limit}).`);
  }

  return {
    // Copied out of the payload buffer: a subarray keeps the whole body alive for
    // as long as any part is held, which for one small part of a large upload is
    // the entire payload retained by accident.
    content: content.slice(),
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
    ...dispositionFields(headers),
    headers,
  };
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  _resource: Record<string, unknown>,
  _ctx: ResourceContext,
): Promise<MultipartDecoder> {
  return new MultipartDecoder();
}

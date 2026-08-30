import { InvokeError } from "@telorun/sdk";

/**
 * SSE frame reading, shared by both dialects' streaming halves.
 *
 * One copy rather than one per dialect: the two differ in what the frames MEAN
 * (chat sends completion chunks terminated by `[DONE]`, responses sends named
 * `response.*` events), never in how a frame is found in a byte stream.
 *
 * This mirrors the rules `SseCodec.Decoder` implements. It stays private because
 * a controller cannot reach another module's kind without putting a decoder
 * reference on every model kind's schema — which would make every author declare
 * one to make a call. When the dialects move into manifests, the chain is
 * `Http.Request → SseCodec.Decoder` and this file goes away.
 */

/** Where a hostile or broken peer turns a stream into memory pressure. TWO
 *  accumulators can grow without a bound: the bytes waiting for a line ending
 *  that may never come, and the payload lines waiting for a blank line that may
 *  never come. Bounding only the first leaves a peer free to send a million
 *  short `data:` lines. Same per-line bound the stdlib decoder uses. */
const MAX_LINE_BYTES = 1 << 20;
const MAX_FRAME_BYTES = 1 << 20;

/**
 * Parse an SSE byte stream into the payload of each frame.
 *
 * A frame's payload may span SEVERAL `data:` lines, joined with newlines — that
 * is the format, and reading each line as its own frame hands a split JSON
 * payload to a parser as two invalid fragments. A frame carrying no `data:` line
 * at all is a comment or a bare field and dispatches nothing.
 *
 * Takes an async iterable rather than a web `ReadableStream`: the bytes arrive
 * from `Http.Request`'s streamed response, which is also what makes a consumer's
 * early exit reach the transport — breaking out of this loop returns the source
 * iterator, and the request controller aborts on that.
 */
export async function* parseSseData(
  body: AsyncIterable<Uint8Array>,
  operation: string,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let pending: string[] = [];
  let pendingBytes = 0;

  const frame = (): string | null => {
    if (pending.length === 0) return null;
    const data = pending.join("\n");
    pending = [];
    pendingBytes = 0;
    return data;
  };

  const overrun = (what: string, limit: number): never => {
    throw new InvokeError(
      "ERR_OPENAI_REQUEST_FAILED",
      `${operation}: ${what} exceeded ${limit} bytes. The peer is not sending Server-Sent Events.`,
    );
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      // A blank line ends a frame; everything accumulated is one payload.
      if (line.trim() === "") {
        const data = frame();
        if (data !== null) yield data;
        continue;
      }
      const payload = sseDataPayload(line);
      if (payload !== null) {
        pending.push(payload);
        pendingBytes += payload.length + 1;
        if (pendingBytes > MAX_FRAME_BYTES) overrun("one frame's payload", MAX_FRAME_BYTES);
      }
    }
    if (buffer.length > MAX_LINE_BYTES) overrun("a line", MAX_LINE_BYTES);
  }

  buffer += decoder.decode();
  const tail = sseDataPayload(buffer);
  if (tail !== null) pending.push(tail);
  // A stream that ends without a trailing blank line still delivers its last
  // frame; the transport's end is as good a terminator as the blank line.
  const last = frame();
  if (last !== null) yield last;
}

/**
 * Return the payload of a `data:` line, or null for a comment, a blank, or any
 * other field line (the responses stream carries an `event:` line per frame).
 *
 * Framing per the format, matching `SseCodec.Decoder`: a line is `field: value`,
 * a leading colon is a comment, and EXACTLY ONE leading space after the colon is
 * part of the framing rather than of the value. Trimming the line instead would
 * accept a leading-space line as a field, which the format does not; trimming the
 * payload would lose trailing whitespace that belongs to it.
 */
function sseDataPayload(line: string): string | null {
  if (line.startsWith(":")) return null;
  const colon = line.indexOf(":");
  const field = colon === -1 ? line : line.slice(0, colon);
  if (field !== "data") return null;
  let value = colon === -1 ? "" : line.slice(colon + 1);
  if (value.startsWith(" ")) value = value.slice(1);
  return value;
}

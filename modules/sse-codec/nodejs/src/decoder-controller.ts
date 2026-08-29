import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";

interface DecoderResource {
  metadata: { name: string; module?: string };
}

interface DecoderInputs {
  input?: unknown;
}

interface SseRecord {
  event: string;
  data: string;
  id?: string;
  retry?: number;
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
    return { records: new Stream(decode(input as AsyncIterable<unknown>)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

/** How much unterminated text is held while waiting for a line break.
 *
 *  A server that never sends one would otherwise grow this without limit — the
 *  failure-body path caps at 8 KB for the same reason, and an unbounded buffer
 *  here is the one place a hostile or broken peer turns a stream into memory
 *  pressure. A frame this long is not a frame. */
const MAX_LINE_BYTES = 1 << 20;

/** One event under construction. `data` is a list because the format allows a
 *  payload to span several `data:` lines, joined by newlines on dispatch. */
interface Pending {
  event?: string;
  data: string[];
  id?: string;
  retry?: number;
}

function emptyPending(): Pending {
  return { data: [] };
}

async function* decode(input: AsyncIterable<unknown>): AsyncIterable<SseRecord> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let pending = emptyPending();

  const dispatch = (): SseRecord | undefined => {
    // A frame with no `data:` line at all is a comment or a bare field, and the
    // format says it dispatches nothing. Distinct from `data:` with an empty
    // value, which IS a record carrying "".
    if (pending.data.length === 0) {
      const carriedId = pending.id;
      pending = emptyPending();
      // An id-only frame still moves the reconnection cursor, so it is kept for
      // the next dispatch rather than dropped with the rest.
      if (carriedId !== undefined) pending.id = carriedId;
      return undefined;
    }
    const record: SseRecord = {
      event: pending.event ?? "message",
      data: pending.data.join("\n"),
      ...(pending.id === undefined ? {} : { id: pending.id }),
      ...(pending.retry === undefined ? {} : { retry: pending.retry }),
    };
    const carriedId = pending.id;
    pending = emptyPending();
    // The last id seen persists across events until replaced — it is a stream
    // cursor, not a property of one frame.
    if (carriedId !== undefined) pending.id = carriedId;
    return record;
  };

  // How much of `buffer` is already known to hold no terminator. Without it a
  // chunk that arrives with no break is rescanned from 0 on every subsequent
  // chunk, which is quadratic in the size of a long unterminated run.
  let scanned = 0;

  for await (const chunk of input) {
    buffer += decoder.decode(toBytes(chunk), { stream: true });
    let cut = nextLineBreak(buffer, scanned);
    while (cut) {
      const line = buffer.slice(0, cut.index);
      buffer = buffer.slice(cut.index + cut.length);
      scanned = 0;
      const record = consumeLine(line, pending);
      if (record === DISPATCH) {
        const out = dispatch();
        if (out) yield out;
      }
      cut = nextLineBreak(buffer, scanned);
    }
    // A trailing `\r` is left unscanned: the `\n` completing a CRLF may be in
    // the next chunk, so it has to be re-examined once more arrives.
    scanned = buffer.endsWith("\r") ? Math.max(0, buffer.length - 1) : buffer.length;
    if (buffer.length > MAX_LINE_BYTES) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Sse.Decoder: ${buffer.length} bytes arrived with no line terminator ` +
          `(limit ${MAX_LINE_BYTES}). The peer is not sending Server-Sent Events.`,
      );
    }
  }

  // Whatever the decoder still holds for an incomplete multi-byte sequence.
  buffer += decoder.decode();
  // A lone trailing `\r` IS a terminator now: no `\n` can follow it, so keeping
  // it would fold the carriage return into the value.
  if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
  if (buffer.length > 0) {
    if (consumeLine(buffer, pending) === DISPATCH) {
      const out = dispatch();
      if (out) yield out;
    }
  }

  // A trailing frame that never got its blank line is DISPATCHED, which departs
  // from the EventSource rule that discards it. That rule serves a reconnecting
  // browser stream, where the partial event arrives again after the reconnect;
  // a one-shot HTTP response has no second delivery, so discarding it would
  // silently drop a terminal frame from any server that closes without the
  // final newline — a truncation with nothing to report it.
  const trailing = dispatch();
  if (trailing) yield trailing;
}

const DISPATCH = Symbol("dispatch");

/** Fold one line into the pending event, or signal that the event is complete.
 *  Field names are exact per the format; an unknown one is ignored, which is
 *  what lets a server add fields without breaking a reader. */
function consumeLine(line: string, pending: Pending): typeof DISPATCH | undefined {
  if (line.length === 0) return DISPATCH;
  // A leading colon is a comment — the keep-alive every SSE server sends.
  if (line.startsWith(":")) return undefined;

  const colon = line.indexOf(":");
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? "" : line.slice(colon + 1);
  // Exactly one leading space is part of the framing, not of the value.
  if (value.startsWith(" ")) value = value.slice(1);

  switch (field) {
    case "event":
      pending.event = value;
      return undefined;
    case "data":
      pending.data.push(value);
      return undefined;
    case "id":
      // The format forbids a NUL in an id and says to ignore the field rather
      // than the event.
      if (!value.includes("\0")) pending.id = value;
      return undefined;
    case "retry": {
      if (/^\d+$/.test(value)) pending.retry = Number(value);
      return undefined;
    }
    default:
      return undefined;
  }
}

interface LineBreak {
  index: number;
  length: number;
}

/** The next line terminator, which the format spells three ways. A lone
 *  trailing `\r` is NOT treated as one WHILE MORE INPUT MAY ARRIVE: the `\n`
 *  completing a CRLF may be in the next chunk, and splitting there would report
 *  one line as two. At end of stream nothing more can arrive, so the caller
 *  terminates on it instead — see the final flush. */
function nextLineBreak(buffer: string, from = 0): LineBreak | undefined {
  for (let i = from; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch === "\n") return { index: i, length: 1 };
    if (ch === "\r") {
      if (i + 1 < buffer.length) {
        return buffer[i + 1] === "\n" ? { index: i, length: 2 } : { index: i, length: 1 };
      }
      return undefined;
    }
  }
  return undefined;
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  throw new InvokeError(
    "ERR_INVALID_INPUT",
    `Sse.Decoder: 'input' must yield bytes; got ${chunk === null ? "null" : typeof chunk}.`,
  );
}

export function register(): void {}

export async function create(
  resource: DecoderResource,
  _ctx: ResourceContext,
): Promise<SseDecoder> {
  return new SseDecoder(resource);
}

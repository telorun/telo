import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { Stream } from "@telorun/sdk";
import {
  asBytes,
  boundaryOf,
  dispositionFields,
  findHeaderEnd,
  indexOf,
  MAX_HEADER_BYTES,
  parseHeaders,
  trimTrailingBreak,
} from "./multipart-framing.js";

interface ReaderInputs {
  input: AsyncIterable<unknown>;
  contentType: string;
}

interface ReadPart {
  content: Stream<Uint8Array>;
  contentType?: string;
  name?: string;
  filename?: string;
  headers: Record<string, string>;
}

interface ReaderOutputs {
  parts: Stream<ReadPart>;
}

const WHO = "Multipart.Reader";

/**
 * Reads a multipart payload incrementally: a stream of parts, each with a stream
 * of bytes.
 *
 * The counterpart to `Multipart.Decoder`, which buffers. Buffering is the right
 * default — parts become ordinary values, and a form's fields are small — but it
 * caps what a server can accept at whatever `maxPartBytes` says. A file upload
 * is exactly the case that cap is wrong for, and raising it only moves the
 * allocation.
 *
 * ADVANCING AUTO-DRAINS. The obvious streaming design requires the consumer to
 * read each part fully before moving on, and makes skipping one a silent
 * use-after-free: the source is single-pass, so a part reached out of order
 * yields nothing rather than failing. Here the outer stream discards whatever is
 * left of the current part before finding the next, so a consumer that inspects
 * headers and skips the body is correct by construction and reads nothing into
 * memory. That turns an ordering CONTRACT the consumer could violate silently
 * into an invariant it cannot.
 *
 * The drain is driven from the UNDERLYING iterator rather than from the stream
 * handed to the consumer, and that is what makes the invariant hold for a PARTIAL
 * read too: `for await … break` closes the consumer's generator, so a flag set at
 * that generator's normal completion stays false and re-iterating it yields
 * nothing. Holding the source iterator separately means "the consumer stopped
 * early" and "the consumer never started" drain by the same path.
 *
 * Memory is bounded by one upstream chunk plus one part's header block, never by
 * a part's size.
 */
class MultipartReader implements ResourceInstance<ReaderInputs, ReaderOutputs> {
  async invoke(inputs: ReaderInputs): Promise<ReaderOutputs> {
    const boundary = boundaryOf(inputs?.contentType, WHO);
    return { parts: new Stream(readParts(inputs.input, boundary)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

/**
 * A byte cursor over the upstream chunks.
 *
 * Holds only what has been read and not yet consumed. `readUntil` is the one
 * primitive the part body needs; the header block is read whole, because it is
 * bounded metadata and the blank line that ends it has four legal spellings.
 */
class ByteCursor {
  private buffer = new Uint8Array(0);
  private done = false;

  constructor(private readonly iterator: AsyncIterator<unknown>) {}

  /** Pull one more chunk into the buffer. False when the source is exhausted. */
  private async pull(): Promise<boolean> {
    if (this.done) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.done = true;
      return false;
    }
    const bytes = asBytes(next.value, WHO);
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer, 0);
    merged.set(bytes, this.buffer.length);
    this.buffer = merged;
    return true;
  }

  /** Everything up to the next occurrence of `needle`, consumed along with it.
   *  Yields as it goes, retaining only `needle.length - 1` bytes so a delimiter
   *  spanning two chunks is still found. */
  async *readUntil(needle: Uint8Array): AsyncIterable<Uint8Array> {
    while (true) {
      const at = indexOf(this.buffer, needle, 0);
      if (at >= 0) {
        if (at > 0) yield this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + needle.length);
        return;
      }
      // Keep back enough that a delimiter straddling the chunk boundary is not
      // emitted as content and then missed.
      const safe = this.buffer.length - (needle.length - 1);
      if (safe > 0) {
        yield this.buffer.slice(0, safe);
        this.buffer = this.buffer.slice(safe);
      }
      if (!(await this.pull())) {
        throw new Error(`${WHO}: the payload ends without a closing boundary — it is truncated.`);
      }
    }
  }

  /**
   * The part's header block, consumed along with the blank line that ends it.
   *
   * Read whole rather than streamed, because the terminator is "a line break
   * followed by a line break" in any of four spellings and a fixed needle can
   * only match one of them — which is what made the Reader reject bare-LF framing
   * the Decoder accepts, and made a part with NO headers (the encoder's own output
   * for a part that declares only `content`) unparseable at all.
   */
  async readHeaderBlock(): Promise<Record<string, string>> {
    while (true) {
      const split = findHeaderEnd(this.buffer);
      if (split) {
        const text = new TextDecoder().decode(this.buffer.subarray(0, split.headerEnd));
        this.buffer = this.buffer.slice(split.contentStart);
        return parseHeaders(text);
      }
      if (this.buffer.length > MAX_HEADER_BYTES) {
        throw new Error(
          `${WHO}: a part's header block exceeds ${MAX_HEADER_BYTES} bytes with no blank line — ` +
            `the payload is not multipart, or its boundary is wrong.`,
        );
      }
      if (!(await this.pull())) {
        throw new Error(`${WHO}: a part has no blank line separating headers from content.`);
      }
    }
  }

  /**
   * Whether the next two bytes are `--`, the closing delimiter's suffix.
   *
   * Running out of bytes HERE is truncation, and is reported as such. Reading it
   * as "not the closing delimiter" sends the caller on to read a header block
   * that does not exist, and the payload is then rejected for having no blank
   * line between headers and content — a cause that is not what went wrong, at a
   * part that was never there.
   */
  async atClosingDelimiter(): Promise<boolean> {
    while (this.buffer.length < 2 && (await this.pull())) {
      /* fill */
    }
    if (this.buffer.length < 2) {
      throw new Error(`${WHO}: the payload ends without a closing boundary — it is truncated.`);
    }
    return this.buffer[0] === 0x2d && this.buffer[1] === 0x2d;
  }

  /** Drop the CRLF (or bare LF) that ends a delimiter line. */
  async skipLineBreak(): Promise<void> {
    while (this.buffer.length < 2 && (await this.pull())) {
      /* fill */
    }
    if (this.buffer[0] === 0x0d && this.buffer[1] === 0x0a) this.buffer = this.buffer.slice(2);
    else if (this.buffer[0] === 0x0a) this.buffer = this.buffer.slice(1);
  }
}

async function* readParts(
  input: AsyncIterable<unknown>,
  boundary: string,
): AsyncIterable<ReadPart> {
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const cursor = new ByteCursor(input[Symbol.asyncIterator]());

  // The preamble before the first delimiter is not a part.
  for await (const _ of cursor.readUntil(delimiter)) {
    /* discard */
  }

  while (true) {
    if (await cursor.atClosingDelimiter()) return;
    await cursor.skipLineBreak();

    const headers = await cursor.readHeaderBlock();

    // The source iterator is held HERE rather than inside the body generator, so
    // the drain below reaches it however the consumer stopped — never started,
    // stopped early, or read to the end.
    const source = cursor.readUntil(delimiter)[Symbol.asyncIterator]();
    let exhausted = false;
    const body = (async function* () {
      // One chunk of lookahead: the line break before the delimiter belongs to
      // the framing, and only the LAST chunk can carry it. Trimming every chunk
      // deletes any 0x0D/0x0A that happens to land on a chunk boundary — silent
      // corruption of arbitrary bytes, for the file uploads this kind exists for.
      let held: Uint8Array | undefined;
      while (true) {
        const next = await source.next();
        if (next.done) {
          exhausted = true;
          if (held) {
            const last = trimTrailingBreak(held);
            if (last.length > 0) yield last;
          }
          return;
        }
        if (held) yield held;
        held = next.value;
      }
    })();

    yield {
      content: new Stream(body),
      ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
      ...dispositionFields(headers),
      headers,
    };

    while (!exhausted) {
      if ((await source.next()).done) break;
    }
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  _resource: Record<string, unknown>,
  _ctx: ResourceContext,
): Promise<MultipartReader> {
  return new MultipartReader();
}

import { limitExceeded, malformed } from "./multipart-errors.js";
import {
  asBytes,
  dispositionFields,
  findHeaderEnd,
  indexOf,
  MAX_HEADER_BYTES,
  parseHeaders,
  trimTrailingBreak,
} from "./multipart-framing.js";

/** The bounds one read is held to. An absent bound is not applied. */
export interface ReadLimits {
  /** One part's content, framing and headers excluded. */
  maxPartBytes?: number;
  maxParts?: number;
  /** Every byte pulled from the source. */
  maxTotalBytes?: number;
}

export interface FramedPart {
  content: AsyncIterable<Uint8Array>;
  contentType?: string;
  name?: string;
  filename?: string;
  headers: Record<string, string>;
}

/** A limit as a caller supplied it: a CEL integer arrives as a bigint. */
export function limitInput(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : Number(value);
}

/**
 * The single-pass source both kinds read, and the one place a read ends.
 *
 * The first failure — a refusal of this module's, or the source's own error,
 * kept as it was raised — is remembered and the source released; every later
 * pull, of a part's content or of the next part, fails with that same error, so
 * nothing is delivered after it.
 */
class PayloadSource {
  private readonly iterator: AsyncIterator<unknown>;
  private total = 0;
  private failure: { error: unknown } | undefined;
  private released = false;

  constructor(
    input: AsyncIterable<unknown>,
    private readonly maxTotalBytes: number | undefined,
    private readonly who: string,
  ) {
    this.iterator = input[Symbol.asyncIterator]();
  }

  /** The next chunk, or `undefined` once the source is exhausted. */
  async pull(): Promise<Uint8Array | undefined> {
    const next = await this.iterator.next();
    if (next.done) return undefined;
    const bytes = asBytes(next.value, this.who);
    this.total += bytes.length;
    if (this.maxTotalBytes !== undefined && this.total > this.maxTotalBytes) {
      throw limitExceeded(
        this.who,
        "maxTotalBytes",
        this.maxTotalBytes,
        `the payload is larger than maxTotalBytes (${this.maxTotalBytes}).`,
      );
    }
    return bytes;
  }

  assertOpen(): void {
    if (this.failure) throw this.failure.error;
  }

  /** Records `error` as how this read ended and hands back the error to raise. */
  async fail(error: unknown): Promise<unknown> {
    if (!this.failure) {
      this.failure = { error };
      await this.release();
    }
    return this.failure.error;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.iterator.return?.();
  }
}

/**
 * A byte cursor over the source's chunks.
 *
 * Holds only what has been read and not yet consumed. `readUntil` is the one
 * primitive the part body needs; the header block is read whole, because it is
 * bounded metadata and the blank line that ends it has four legal spellings.
 */
class ByteCursor {
  private buffer = new Uint8Array(0);
  private done = false;

  constructor(
    private readonly source: PayloadSource,
    private readonly who: string,
  ) {}

  /** Pull one more chunk into the buffer. False when the source is exhausted. */
  private async pull(): Promise<boolean> {
    if (this.done) return false;
    const bytes = await this.source.pull();
    if (!bytes) {
      this.done = true;
      return false;
    }
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer, 0);
    merged.set(bytes, this.buffer.length);
    this.buffer = merged;
    return true;
  }

  private truncated(): Error {
    return malformed(
      this.who,
      "truncated",
      "the payload ends without a closing boundary — it is truncated.",
    );
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
      if (!(await this.pull())) throw this.truncated();
    }
  }

  /**
   * The part's header block, consumed along with the blank line that ends it.
   *
   * Read whole rather than streamed, because the terminator is "a line break
   * followed by a line break" in any of four spellings and a fixed needle can
   * only match one of them, and because a part with NO headers (the encoder's own
   * output for a part that declares only `content`) opens with the blank line.
   */
  async readHeaderBlock(): Promise<Record<string, string>> {
    while (true) {
      const split = findHeaderEnd(this.buffer);
      if (split) {
        const text = new TextDecoder().decode(this.buffer.subarray(0, split.headerEnd));
        this.buffer = this.buffer.slice(split.contentStart);
        return parseHeaders(text, this.who);
      }
      if (this.buffer.length > MAX_HEADER_BYTES) {
        throw malformed(
          this.who,
          "header-too-large",
          `a part's header block exceeds ${MAX_HEADER_BYTES} bytes with no blank line — ` +
            `the payload is not multipart, or its boundary is wrong.`,
        );
      }
      if (!(await this.pull())) throw this.truncated();
    }
  }

  /**
   * Whether the next two bytes are `--`, the closing delimiter's suffix.
   *
   * Running out of bytes HERE is truncation, and is reported as such. Reading it
   * as "not the closing delimiter" sends the caller on to read a header block
   * that does not exist.
   */
  async atClosingDelimiter(): Promise<boolean> {
    while (this.buffer.length < 2 && (await this.pull())) {
      /* fill */
    }
    if (this.buffer.length < 2) throw this.truncated();
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

/**
 * A part's content off its framed section: the line break before the delimiter
 * belongs to the framing, and only the LAST chunk can carry it, so one chunk is
 * held back. Trimming every chunk would delete any 0x0D/0x0A that happens to
 * land on a chunk boundary.
 *
 * `maxPartBytes` measures content alone, whether the consumer reads the part or
 * skips it, and is judged as bytes arrive rather than as they are delivered: at
 * most two of them can still prove to be framing.
 */
async function* partContent(
  section: AsyncIterable<Uint8Array>,
  maxPartBytes: number | undefined,
  refuse: () => Error,
): AsyncIterable<Uint8Array> {
  let held: Uint8Array | undefined;
  let arrived = 0;
  for await (const chunk of section) {
    arrived += chunk.length;
    if (maxPartBytes !== undefined && arrived - 2 > maxPartBytes) throw refuse();
    if (held) yield held;
    held = chunk;
  }
  if (!held) return;
  const last = trimTrailingBreak(held);
  const size = arrived - (held.length - last.length);
  if (maxPartBytes !== undefined && size > maxPartBytes) throw refuse();
  if (last.length > 0) yield last;
}

/**
 * The parts of a multipart payload, in order, each with its content as a
 * single-pass byte source.
 *
 * ADVANCING AUTO-DRAINS. The source is single-pass, so a consumer that moved on
 * without reading a part to its end would otherwise read nothing from the next
 * one. Asking for the next part discards whatever is left of the current one.
 * The drain is driven from the part's own iterator, held HERE rather than by the
 * consumer, so "never started", "stopped early" and "read to the end" all drain
 * by the same path.
 */
export async function* readParts(
  input: AsyncIterable<unknown>,
  boundary: string,
  limits: ReadLimits,
  who: string,
): AsyncIterable<FramedPart> {
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const source = new PayloadSource(input, limits.maxTotalBytes, who);
  const cursor = new ByteCursor(source, who);
  try {
    // The preamble before the first delimiter is not a part.
    for await (const preamble of cursor.readUntil(delimiter)) void preamble;

    for (let index = 0; ; index++) {
      if (await cursor.atClosingDelimiter()) return;
      if (limits.maxParts !== undefined && index >= limits.maxParts) {
        throw limitExceeded(
          who,
          "maxParts",
          limits.maxParts,
          `the payload holds more than maxParts (${limits.maxParts}) parts.`,
          { index },
        );
      }
      await cursor.skipLineBreak();

      const headers = await cursor.readHeaderBlock();
      const fields = dispositionFields(headers);
      const content = partContent(cursor.readUntil(delimiter), limits.maxPartBytes, () =>
        limitExceeded(
          who,
          "maxPartBytes",
          limits.maxPartBytes!,
          `part ${index}${fields.name === undefined ? "" : ` ('${fields.name}')`} is larger than maxPartBytes (${limits.maxPartBytes}).`,
          { index, name: fields.name },
        ),
      )[Symbol.asyncIterator]();
      let exhausted = false;
      const next = async (): Promise<IteratorResult<Uint8Array>> => {
        source.assertOpen();
        try {
          const result = await content.next();
          if (result.done) exhausted = true;
          return result;
        } catch (err) {
          throw await source.fail(err);
        }
      };

      yield {
        content: {
          [Symbol.asyncIterator]: () => ({
            next,
            // Stopping early leaves the remainder to the drain below.
            return: async () => ({ done: true, value: undefined }),
          }),
        },
        ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
        ...fields,
        headers,
      };

      while (!exhausted) await next();
    }
  } catch (err) {
    throw await source.fail(err);
  } finally {
    await source.release();
  }
}

/** A byte source read as far as its leading window, and no further. */
export interface Opened {
  /** The first bytes of the source, at most the window. */
  leading: Uint8Array;
  /** Every byte of the source, the chunks already read first. Read once. */
  content: AsyncIterable<Uint8Array>;
}

/** Turns one value a source yielded into bytes, or throws the refusal. */
export type ChunkReader = (value: unknown) => Uint8Array;

/** Bytes held whole: nothing is read, and `content` yields them as one chunk. */
export function openBytes(bytes: Uint8Array, window: number): Opened {
  return { leading: bytes.subarray(0, window), content: new Replay([bytes], undefined, asIs) };
}

/**
 * Pulls chunks until `window` bytes are held or the source ends. A failure of
 * the source is rethrown as raised; a chunk `readChunk` refuses releases the
 * source first.
 */
export async function openStream(
  source: AsyncIterable<unknown>,
  window: number,
  readChunk: ChunkReader,
): Promise<Opened> {
  const iterator = source[Symbol.asyncIterator]();
  const held: Uint8Array[] = [];
  let size = 0;
  let ended = false;
  while (size < window) {
    const step = await iterator.next();
    if (step.done) {
      ended = true;
      break;
    }
    const chunk = await readOrRelease(step.value, readChunk, iterator);
    held.push(chunk);
    size += chunk.byteLength;
  }
  const leading = new Uint8Array(Math.min(size, window));
  let at = 0;
  for (const chunk of held) {
    if (at >= leading.byteLength) break;
    const part = chunk.subarray(0, leading.byteLength - at);
    leading.set(part, at);
    at += part.byteLength;
  }
  return { leading, content: new Replay(held, ended ? undefined : iterator, readChunk) };
}

async function readOrRelease(
  value: unknown,
  readChunk: ChunkReader,
  iterator: AsyncIterator<unknown>,
): Promise<Uint8Array> {
  let chunk: Uint8Array;
  try {
    chunk = readChunk(value);
  } catch (refusal) {
    await iterator.return?.();
    throw refusal;
  }
  return chunk;
}

const asIs: ChunkReader = (value) => value as Uint8Array;

/**
 * The chunks already read, then the rest of the source. An iterator object
 * rather than a generator, so that stopping before the first pull still
 * releases the source.
 */
class Replay implements AsyncIterable<Uint8Array> {
  private at = 0;

  constructor(
    private readonly held: Uint8Array[],
    private rest: AsyncIterator<unknown> | undefined,
    private readonly readChunk: ChunkReader,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => this.next(),
      return: async () => {
        await this.release();
        return { done: true, value: undefined };
      },
    };
  }

  private async next(): Promise<IteratorResult<Uint8Array>> {
    if (this.at < this.held.length) return { done: false, value: this.held[this.at++] };
    const rest = this.rest;
    if (rest === undefined) return { done: true, value: undefined };
    let step: IteratorResult<unknown>;
    try {
      step = await rest.next();
    } catch (failure) {
      // The source ended itself by failing; there is nothing left to release.
      this.rest = undefined;
      throw failure;
    }
    if (step.done) {
      this.rest = undefined;
      return { done: true, value: undefined };
    }
    let chunk: Uint8Array;
    try {
      chunk = this.readChunk(step.value);
    } catch (refusal) {
      await this.release();
      throw refusal;
    }
    return { done: false, value: chunk };
  }

  private async release(): Promise<void> {
    const rest = this.rest;
    this.at = this.held.length;
    this.rest = undefined;
    await rest?.return?.();
  }
}

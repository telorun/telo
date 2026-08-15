import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { Stream } from "@telorun/sdk";

interface ChunkResource {
  metadata: { name: string; module?: string };
  size?: number | bigint;
}

interface ChunkInputs {
  input: AsyncIterable<unknown>;
  size?: number | bigint;
}

interface ChunkRecord {
  bytes: Uint8Array;
  offset: bigint;
  length: bigint;
  index: bigint;
  last: boolean;
}

interface ChunkOutputs {
  output: Stream<ChunkRecord>;
}

/**
 * Re-frames a byte stream into fixed-size chunks.
 *
 * The upstream stream's chunk boundaries are an artifact of however the bytes
 * arrived — a socket read, a file read-ahead — and are never the boundaries a
 * consumer wants. A resumable upload needs a size the far end mandates; a framed
 * protocol needs its own frame size. So this coalesces and splits: it buffers
 * until `size` bytes are available, emits exactly that many, and carries the
 * remainder forward. Only the final record is short.
 *
 * Each record carries its OFFSET and whether it is the last, which is what makes
 * a `Content-Range` header (and any other positional framing) expressible in CEL
 * with no arithmetic across steps. Deriving the offset downstream would mean
 * accumulating state the iteration body has nowhere to keep.
 *
 * Streaming end to end: one `size`-byte buffer is live at a time, never the
 * whole source. Chunking a stream by materializing it would defeat the reason to
 * chunk at all.
 */
class StreamChunk implements ResourceInstance<ChunkInputs, ChunkOutputs> {
  constructor(private readonly resource: ChunkResource) {}

  async invoke(inputs: ChunkInputs): Promise<ChunkOutputs> {
    const size = Number(inputs?.size ?? this.resource.size ?? 0);
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error(
        `Stream.Chunk: 'size' must be a positive integer number of bytes (got ${String(
          inputs?.size ?? this.resource.size,
        )}).`,
      );
    }
    return { output: new Stream(chunk(inputs.input, size)) };
  }

  snapshot(): Record<string, unknown> {
    return { size: this.resource.size };
  }
}

/** A chunk of exactly `size` bytes, except the last. `subarray` would alias the
 *  carry buffer, which the next iteration overwrites, so each emitted record
 *  owns its bytes. */
async function* chunk(input: AsyncIterable<unknown>, size: number): AsyncIterable<ChunkRecord> {
  let carry = new Uint8Array(0);
  let offset = 0n;
  let index = 0n;

  const emit = (bytes: Uint8Array, last: boolean): ChunkRecord => {
    const record: ChunkRecord = {
      bytes,
      offset,
      length: BigInt(bytes.length),
      index,
      last,
    };
    offset += BigInt(bytes.length);
    index += 1n;
    return record;
  };

  for await (const piece of input) {
    const bytes = asBytes(piece);
    if (bytes.length === 0) continue;
    const merged = new Uint8Array(carry.length + bytes.length);
    merged.set(carry, 0);
    merged.set(bytes, carry.length);
    carry = merged;

    // Only ever hold back less than one chunk: a slow producer must not make the
    // buffer grow with the source.
    let cut = 0;
    while (carry.length - cut >= size) {
      yield emit(carry.slice(cut, cut + size), false);
      cut += size;
    }
    carry = carry.slice(cut);
  }

  // A short final record, or — for an empty source — nothing at all. Emitting an
  // empty final chunk would make `last` arrive with no bytes, and a consumer
  // sending it would issue a zero-length request.
  if (carry.length > 0) yield emit(carry, true);
}

/** Accepts what a byte producer actually emits. A string is decoded as UTF-8
 *  rather than rejected, because a text codec upstream is a normal pipeline; a
 *  non-byte value is an error, never a silent coercion through `String(...)`. */
function asBytes(piece: unknown): Uint8Array {
  if (piece instanceof Uint8Array) return piece;
  if (typeof piece === "string") return new TextEncoder().encode(piece);
  if (piece instanceof ArrayBuffer) return new Uint8Array(piece);
  if (ArrayBuffer.isView(piece)) {
    return new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength);
  }
  throw new Error(
    `Stream.Chunk: input yielded ${typeof piece} — expected bytes (Uint8Array) or a string.`,
  );
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: ChunkResource,
  _ctx: ResourceContext,
): Promise<StreamChunk> {
  return new StreamChunk(resource);
}

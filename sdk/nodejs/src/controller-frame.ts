/**
 * The frame of the controller protocol's framed carrier
 * (`kernel/specs/controller-protocol.md` §3.1, §3.3), shared by every carrier that
 * speaks it — the desktop-host control channel (`kernel/specs/desktop-host.md`) among
 * them. It knows the frame and nothing of the envelope in its meta: that is the
 * typed-frame JSON of `typed-frame.ts`, whose members the speaker decides.
 *
 * ```
 * length      u32, big-endian   bytes that follow this field
 * class       u8                0x01 message frame, 0x02 data frame
 * metaLength  u32, big-endian   bytes of the meta region
 * meta        metaLength bytes  UTF-8
 * data        the rest          uninterpreted bytes
 * ```
 */

/** The largest `length` a frame may carry (16 MiB). */
export const MAX_FRAME_LENGTH = 16777216;

const CLASS_MESSAGE = 0x01;
const CLASS_DATA = 0x02;
const PREFIX = 4;
const MINIMUM_LENGTH = 5;

export type FrameClass = "message" | "data";

export interface Frame {
  class: FrameClass;
  meta: string;
  data: Uint8Array;
}

/** A frame a reader refuses. Terminal for the carrier instance that read it. */
export class FrameRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameRefusal";
  }
}

const encoder = new TextEncoder();

/** Writes one frame. Refuses a frame whose length would exceed {@link MAX_FRAME_LENGTH}. */
export function encodeFrame(cls: FrameClass, meta: string, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const metaBytes = encoder.encode(meta);
  const length = MINIMUM_LENGTH + metaBytes.length + data.length;
  if (length > MAX_FRAME_LENGTH) throw new FrameRefusal(`a frame of ${length} bytes exceeds MAX_FRAME_LENGTH`);
  const out = new Uint8Array(PREFIX + length);
  const view = new DataView(out.buffer);
  view.setUint32(0, length);
  out[4] = cls === "message" ? CLASS_MESSAGE : CLASS_DATA;
  view.setUint32(5, metaBytes.length);
  out.set(metaBytes, 9);
  out.set(data, 9 + metaBytes.length);
  return out;
}

/** The length a frame's prefix declares, refused before any body is read. */
function declaredLength(prefix: DataView): number {
  const length = prefix.getUint32(0);
  if (length > MAX_FRAME_LENGTH) throw new FrameRefusal(`a length of ${length} exceeds MAX_FRAME_LENGTH`);
  if (length < MINIMUM_LENGTH) {
    throw new FrameRefusal(`a frame of length ${length} carries no class byte and no metaLength`);
  }
  return length;
}

/** Reads the body of a frame whose `length` bytes follow the prefix. */
function readBody(body: Uint8Array): Frame {
  const cls = body[0];
  if (cls !== CLASS_MESSAGE && cls !== CLASS_DATA) throw new FrameRefusal(`no frame class is 0x${cls!.toString(16)}`);
  const metaLength = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(1);
  if (metaLength > body.length - MINIMUM_LENGTH) {
    throw new FrameRefusal(`a metaLength of ${metaLength} exceeds length - 5`);
  }
  let meta: string;
  try {
    meta = new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(5, 5 + metaLength));
  } catch {
    throw new FrameRefusal("a frame's meta is not well-formed UTF-8");
  }
  const data = body.subarray(5 + metaLength);
  if (cls === CLASS_MESSAGE) {
    if (data.length > 0) throw new FrameRefusal("a message frame's whole content is its envelope");
    return { class: "message", meta, data };
  }
  return { class: "data", meta, data };
}

/** Reads exactly one frame from `bytes`, which must hold it whole and nothing else. */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < PREFIX) throw new FrameRefusal("a frame's four-byte length prefix is truncated");
  const length = declaredLength(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (bytes.length !== PREFIX + length) {
    throw new FrameRefusal(`a frame of length ${length} is ${bytes.length - PREFIX} bytes long`);
  }
  return readBody(bytes.subarray(PREFIX));
}

/**
 * Reads frames from a byte stream arriving in arbitrary chunks. A refusal is
 * terminal: the reader throws the same refusal on every later call, because a
 * stream is never resynchronised after one (§3.5).
 */
export class FrameReader {
  // Chunks not yet consumed, with their total length: bytes are joined once a whole frame is present.
  private chunks: Uint8Array[] = [];
  private length = 0;
  private refused: FrameRefusal | undefined;

  /** The frames `chunk` completes, in order. */
  push(chunk: Uint8Array): Frame[] {
    if (this.refused) throw this.refused;
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
    const frames: Frame[] = [];
    try {
      for (;;) {
        if (this.length < PREFIX) break;
        const prefix = this.take(PREFIX, false);
        const declared = declaredLength(new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength));
        if (this.length < PREFIX + declared) break;
        frames.push(readBody(this.take(PREFIX + declared, true).subarray(PREFIX)));
      }
    } catch (err) {
      this.refused = err as FrameRefusal;
      throw this.refused;
    }
    return frames;
  }

  /** Call when the stream ends: a partial frame left behind is a truncated one. */
  end(): void {
    if (this.refused) throw this.refused;
    if (this.length > 0) {
      this.refused = new FrameRefusal(`the stream ended inside a frame, ${this.length} bytes in`);
      throw this.refused;
    }
  }

  /** The first `count` pending bytes as one array; `consume` also removes them. */
  private take(count: number, consume: boolean): Uint8Array {
    const first = this.chunks[0];
    if (first.length >= count) {
      if (consume) {
        if (first.length === count) this.chunks.shift();
        else this.chunks[0] = first.subarray(count);
        this.length -= count;
      }
      return first.subarray(0, count);
    }
    const out = new Uint8Array(count);
    let filled = 0;
    let used = 0;
    let remainder: Uint8Array | undefined;
    while (filled < count) {
      const chunk = this.chunks[used];
      const n = Math.min(chunk.length, count - filled);
      out.set(chunk.subarray(0, n), filled);
      filled += n;
      if (n < chunk.length) remainder = chunk.subarray(n);
      else used++;
    }
    if (consume) {
      this.chunks.splice(0, used);
      if (remainder) this.chunks[0] = remainder;
      this.length -= count;
    }
    return out;
  }
}

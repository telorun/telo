// Judges WebSocket message sizes from the frame headers on the raw socket, so a
// message over the tunnel's limits is refused with `4400` before its payload is
// buffered. A WebSocket library's own payload bound closes with `1009` instead,
// and has one bound for both message types.

export interface MessageSizeLimits {
  textBytes: number;
  binaryBytes: number;
}

export interface OversizeMessage {
  kind: "text" | "binary";
  /** The message's size so far: at least this many bytes. */
  bytes: number;
  limit: number;
}

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;

/**
 * Fed every byte read from the socket after the upgrade, in order, it calls
 * `onOversize` once, at the header of the frame that takes a message over its
 * limit. It reads headers only; payloads are skipped. The tunnel negotiates no
 * extension, so a frame's length is its payload's length.
 */
export class MessageSizeGuard {
  private readonly header = Buffer.alloc(14);
  private headerLength = 0;
  private headerNeeded = 2;
  private payloadLeft = 0;
  private messageKind: "text" | "binary" | undefined;
  private messageBytes = 0;
  private tripped = false;

  constructor(
    private readonly limits: MessageSizeLimits,
    private readonly onOversize: (message: OversizeMessage) => void,
  ) {}

  write(chunk: Buffer): void {
    let at = 0;
    while (at < chunk.length && !this.tripped) {
      if (this.payloadLeft > 0) {
        const skipped = Math.min(this.payloadLeft, chunk.length - at);
        this.payloadLeft -= skipped;
        at += skipped;
        continue;
      }
      this.header[this.headerLength++] = chunk[at++]!;
      if (this.headerLength === 2) this.headerNeeded = 2 + extendedLengthBytes(this.header[1]!) + maskBytes(this.header[1]!);
      if (this.headerLength === this.headerNeeded) this.frameHeader();
    }
  }

  private frameHeader(): void {
    const first = this.header[0]!;
    const second = this.header[1]!;
    const length = payloadLength(this.header, second);
    this.headerLength = 0;
    this.headerNeeded = 2;
    this.payloadLeft = length;

    const opcode = first & 0x0f;
    if (opcode >= 0x8) return;
    if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
      this.messageKind = opcode === OPCODE_TEXT ? "text" : "binary";
      this.messageBytes = length;
    } else if (opcode === OPCODE_CONTINUATION && this.messageKind !== undefined) {
      this.messageBytes += length;
    } else {
      return;
    }
    const limit = this.messageKind === "text" ? this.limits.textBytes : this.limits.binaryBytes;
    if (this.messageBytes > limit) {
      this.tripped = true;
      this.onOversize({ kind: this.messageKind, bytes: this.messageBytes, limit });
      return;
    }
    if ((first & 0x80) !== 0) {
      this.messageKind = undefined;
      this.messageBytes = 0;
    }
  }
}

function extendedLengthBytes(second: number): number {
  const length = second & 0x7f;
  return length === 126 ? 2 : length === 127 ? 8 : 0;
}

function maskBytes(second: number): number {
  return (second & 0x80) !== 0 ? 4 : 0;
}

function payloadLength(header: Buffer, second: number): number {
  const length = second & 0x7f;
  if (length === 126) return header.readUInt16BE(2);
  if (length === 127) return header.readUInt32BE(2) * 2 ** 32 + header.readUInt32BE(6);
  return length;
}

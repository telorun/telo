/** Git's pkt-line framing (`gitprotocol-common`): four hex digits of length,
 *  the payload, and the special packets `0000` (flush), `0001` (delim) and
 *  `0002` (response end). */

export type PktLine = { kind: "data"; payload: Uint8Array } | { kind: "flush" } | { kind: "delim" } | { kind: "end" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEX_DIGIT = /^[0-9a-f]$/i;

/** One data packet holding `text`. */
export function pktLine(text: string): Uint8Array {
  const payload = encoder.encode(text);
  const header = encoder.encode((payload.length + 4).toString(16).padStart(4, "0"));
  const out = new Uint8Array(header.length + payload.length);
  out.set(header);
  out.set(payload, header.length);
  return out;
}

export const FLUSH_PKT = encoder.encode("0000");
export const DELIM_PKT = encoder.encode("0001");

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Reads pkt-lines from bytes arriving in chunks, holding only the packet not yet
 * complete (at most 65520 bytes). A refusal names a byte position, never the
 * bytes themselves.
 */
export class PktLineReader {
  private pending: Uint8Array = new Uint8Array(0);
  private consumed = 0;

  /** The packets `chunk` completes, in order. */
  push(chunk: Uint8Array): PktLine[] {
    const bytes = this.pending.length === 0 ? chunk : concatBytes([this.pending, chunk]);
    const lines: PktLine[] = [];
    let at = 0;
    while (bytes.length - at >= 4) {
      let length = 0;
      for (let digit = 0; digit < 4; digit++) {
        const char = String.fromCharCode(bytes[at + digit]!);
        if (!HEX_DIGIT.test(char)) throw new Error(`the answer holds no pkt-line length at byte ${this.consumed + at}`);
        length = length * 16 + parseInt(char, 16);
      }
      if (length === 3) throw new Error(`the answer holds a pkt-line of length 3 at byte ${this.consumed + at}`);
      if (length < 4) {
        lines.push(length === 0 ? { kind: "flush" } : length === 1 ? { kind: "delim" } : { kind: "end" });
        at += 4;
        continue;
      }
      if (bytes.length - at < length) break;
      lines.push({ kind: "data", payload: bytes.slice(at + 4, at + length) });
      at += length;
    }
    this.consumed += at;
    this.pending = bytes.slice(at);
    return lines;
  }

  /** Refuses an answer ending inside a packet. */
  end(): void {
    if (this.pending.length > 0) throw new Error(`the answer ends inside a pkt-line at byte ${this.consumed}`);
  }
}

/** Every packet of `bytes`, in order; refuses bytes that are not pkt-lines. */
export function readPktLines(bytes: Uint8Array): PktLine[] {
  const reader = new PktLineReader();
  const lines = reader.push(bytes);
  reader.end();
  return lines;
}

/** A data packet's payload as text, without its trailing line feed. */
export function pktText(line: PktLine): string | undefined {
  if (line.kind !== "data") return undefined;
  return decoder.decode(line.payload).replace(/\n$/, "");
}

/** Text a host sent, as an error may quote it: printable ASCII only, at most 120 characters. */
export function excerpt(text: string): string {
  const printable = text.replace(/[^\x20-\x7e]/g, "?").trim();
  return printable.length > 120 ? `${printable.slice(0, 120)}…` : printable;
}

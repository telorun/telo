export type ByteEncoding = "hex" | "base64url" | "base64";

/** Text is its UTF-8 bytes; bytes are themselves. */
export type CryptoInput = string | Uint8Array;

export function toBytes(input: CryptoInput): Uint8Array {
  return typeof input === "string" ? new TextEncoder().encode(input) : input;
}

export function encodeBytes(bytes: Uint8Array, encoding: ByteEncoding): string {
  return Buffer.from(bytes).toString(encoding);
}

const SHAPES: Record<ByteEncoding, RegExp> = {
  hex: /^(?:[0-9a-fA-F]{2})*$/,
  base64url: /^[A-Za-z0-9_-]*$/,
  base64: /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
};

/** Decodes strictly: text that is not valid in the encoding is `null`. */
export function decodeBytes(text: string, encoding: ByteEncoding): Uint8Array | null {
  if (!SHAPES[encoding].test(text)) return null;
  return new Uint8Array(Buffer.from(text, encoding));
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = 62n;
const ID_CHARS = 22;
const SECRET_CHARS = 43;
const CHECKSUM_CHARS = 6;
const BODY_CHARS = ID_CHARS + SECRET_CHARS + CHECKSUM_CHARS;
const MAX_UINT128 = (1n << 128n) - 1n;

export const PUBLIC_ID_PREFIX = "apk_";
/** The prefix a source may carry: lower-case letters and digits, no underscore. */
export const PREFIX_PATTERN = /^[a-z][a-z0-9]{1,14}$/;
export const PUBLIC_ID_PATTERN = /^apk_[0-9A-Za-z]{22}$/;
export const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3) of the text's UTF-8 bytes. */
export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, "utf8")) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** `value` in base 62 (`0-9A-Za-z`), most significant digit first, left-padded with `0` to `width`. */
export function base62Encode(value: bigint, width: number): string {
  if (value < 0n) throw new RangeError("base62 encodes non-negative integers");
  let out = "";
  for (let rest = value; rest > 0n; rest /= BASE) out = ALPHABET[Number(rest % BASE)]! + out;
  if (out.length > width) throw new RangeError(`${value} does not fit in ${width} base62 characters`);
  return out.padStart(width, "0");
}

/** The integer a base-62 text spells, or undefined when it holds another character. */
export function base62Decode(text: string): bigint | undefined {
  let out = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return undefined;
    out = out * BASE + BigInt(digit);
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

/** The key's id as a canonical lower-case UUID, from 16 bytes. */
export function uuidFromBytes(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A UUIDv7: 48 bits of millisecond time, then random bits, so keys sort by creation. */
export function newKeyId(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(nowMs, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return uuidFromBytes(bytes);
}

/** `apk_` plus the 22 base-62 characters of the id's 128 bits. */
export function publicIdOf(uuid: string): string {
  return PUBLIC_ID_PREFIX + base62Encode(BigInt(`0x${uuid.replaceAll("-", "")}`), ID_CHARS);
}

/** The store's UUID for a public id, or undefined when the text is no public id. */
export function uuidOfPublicId(publicId: string): string | undefined {
  return PUBLIC_ID_PATTERN.test(publicId) ? uuidOfIdChars(publicId.slice(PUBLIC_ID_PREFIX.length)) : undefined;
}

function uuidOfIdChars(chars: string): string | undefined {
  const value = base62Decode(chars);
  if (value === undefined || value > MAX_UINT128) return undefined;
  return uuidFromBytes(Buffer.from(value.toString(16).padStart(32, "0"), "hex"));
}

/** The key text for an id and secret: `<prefix>_<id><secret><checksum>`. */
export function formatKey(prefix: string, idBytes: Uint8Array, secretBytes: Uint8Array): string {
  const body = `${prefix}_${base62Encode(bytesToBigInt(idBytes), ID_CHARS)}${base62Encode(bytesToBigInt(secretBytes), SECRET_CHARS)}`;
  return body + base62Encode(BigInt(crc32(body)), CHECKSUM_CHARS);
}

export interface MintedKey {
  /** The key as the holder is given it, shown once. */
  readonly key: string;
  /** The store's id: a UUIDv7. */
  readonly uuid: string;
  /** `apk_<id characters>`. */
  readonly id: string;
  /** SHA-256 of `key`, base64url. */
  readonly digest: string;
}

export function mintKey(prefix: string, nowMs: number = Date.now()): MintedKey {
  const uuid = newKeyId(nowMs);
  const idBytes = Buffer.from(uuid.replaceAll("-", ""), "hex");
  const key = formatKey(prefix, idBytes, randomBytes(32));
  return { key, uuid, id: publicIdOf(uuid), digest: digestOf(key) };
}

export function digestOf(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("base64url");
}

/** Whether two digests are equal, in time independent of where they differ. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export type ParsedKey =
  | { readonly ok: true; readonly prefix: string; readonly uuid: string }
  | { readonly ok: false };

/** Reads a presented key: its shape, its checksum and its id. Touches no store. */
export function parseKey(text: string): ParsedKey {
  const underscore = text.indexOf("_");
  if (underscore < 0) return { ok: false };
  const prefix = text.slice(0, underscore);
  const body = text.slice(underscore + 1);
  if (!PREFIX_PATTERN.test(prefix) || body.length !== BODY_CHARS) return { ok: false };
  const checksum = body.slice(ID_CHARS + SECRET_CHARS);
  const signed = text.slice(0, text.length - CHECKSUM_CHARS);
  if (base62Decode(body.slice(0, ID_CHARS + SECRET_CHARS)) === undefined) return { ok: false };
  if (checksum !== base62Encode(BigInt(crc32(signed)), CHECKSUM_CHARS)) return { ok: false };
  const uuid = uuidOfIdChars(body.slice(0, ID_CHARS));
  return uuid === undefined ? { ok: false } : { ok: true, prefix, uuid };
}

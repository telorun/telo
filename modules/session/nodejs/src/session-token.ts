import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = 62n;
export const ID_CHARS = 22;
export const VALIDATOR_CHARS = 43;
export const TOKEN_CHARS = ID_CHARS + VALIDATOR_CHARS;
export const PUBLIC_ID_PREFIX = "ses_";
export const PUBLIC_ID_PATTERN = /^ses_[0-9A-Za-z]{22}$/;

function base62Encode(value: bigint, width: number): string {
  let out = "";
  for (let rest = value; rest > 0n; rest /= BASE) out = ALPHABET[Number(rest % BASE)]! + out;
  return out.padStart(width, "0");
}

function randomBase62(byteCount: number, width: number): string {
  return base62Encode(BigInt(`0x${randomBytes(byteCount).toString("hex")}`), width);
}

export interface MintedToken {
  /** The 22 base-62 characters naming the session in the store. */
  readonly id: string;
  /** The whole token: the id, then the validator. Shown once. */
  readonly token: string;
  /** SHA-256 of the validator, base64url; the only form that is stored. */
  readonly digest: string;
}

export function mintToken(): MintedToken {
  const id = randomBase62(16, ID_CHARS);
  const validator = randomBase62(32, VALIDATOR_CHARS);
  return { id, token: id + validator, digest: digestOf(validator) };
}

export type ParsedToken = { readonly ok: true; readonly id: string; readonly validator: string } | { readonly ok: false };

/** A presented token's id and validator, or not-ok when it has the wrong length or alphabet. */
export function parseToken(text: string): ParsedToken {
  if (text.length !== TOKEN_CHARS || !/^[0-9A-Za-z]+$/.test(text)) return { ok: false };
  return { ok: true, id: text.slice(0, ID_CHARS), validator: text.slice(ID_CHARS) };
}

export function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("base64url");
}

/** Whether two digests are equal, in time independent of where they differ. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export const publicIdOf = (id: string): string => PUBLIC_ID_PREFIX + id;
export const idOfPublicId = (publicId: string): string | undefined =>
  PUBLIC_ID_PATTERN.test(publicId) ? publicId.slice(PUBLIC_ID_PREFIX.length) : undefined;

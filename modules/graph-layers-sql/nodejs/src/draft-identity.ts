import { randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const PUBLIC_ID = /^gdr_[0-9A-Za-z]{22}$/;

/** A draft's public id: `gdr_` and 128 random bits in base 62, fixed width.
 *  It is the only name of a draft that leaves the store. */
export function newDraftPublicId(): string {
  let value = BigInt(`0x${randomBytes(16).toString("hex")}`);
  let text = "";
  for (let digit = 0; digit < 22; digit++) {
    text = BASE62[Number(value % 62n)] + text;
    value /= 62n;
  }
  return `gdr_${text}`;
}

export function isDraftPublicId(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_ID.test(value);
}

/** A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then random bits, so
 *  internal ids index in creation order. */
export function newInternalId(): string {
  const bytes = randomBytes(16);
  const millis = BigInt(Date.now());
  for (let index = 0; index < 6; index++) {
    bytes[index] = Number((millis >> BigInt(8 * (5 - index))) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

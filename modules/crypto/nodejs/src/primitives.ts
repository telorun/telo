import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { InvokeError } from "@telorun/sdk";
import { decodeBytes, encodeBytes, toBytes, type ByteEncoding, type CryptoInput } from "./byte-encoding.js";

export type DigestAlgorithm = "sha256" | "sha384" | "sha512";

const MAX_RANDOM_BYTES = 65536;
const DIGEST_LENGTH: Record<DigestAlgorithm, number> = { sha256: 32, sha384: 48, sha512: 64 };

export function randomValue(bytes = 32, encoding: ByteEncoding = "base64url"): string {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_RANDOM_BYTES) {
    throw new InvokeError("ERR_INPUT_INVALID", `bytes must be an integer from 1 to ${MAX_RANDOM_BYTES}.`);
  }
  return encodeBytes(randomBytes(bytes), encoding);
}

export function digest(
  input: CryptoInput,
  algorithm: DigestAlgorithm = "sha256",
  encoding: ByteEncoding = "hex",
): string {
  return encodeBytes(createHash(algorithm).update(toBytes(input)).digest(), encoding);
}

export function hmacSign(
  key: CryptoInput,
  input: CryptoInput,
  algorithm: DigestAlgorithm = "sha256",
  encoding: ByteEncoding = "hex",
): string {
  return encodeBytes(createHmac(algorithm, toBytes(key)).update(toBytes(input)).digest(), encoding);
}

/** Decodes `expected` and compares in constant time; text that will not decode is not valid. */
export function hmacVerify(
  key: CryptoInput,
  input: CryptoInput,
  expected: string,
  algorithm: DigestAlgorithm = "sha256",
  encoding: ByteEncoding = "hex",
): boolean {
  const decoded = decodeBytes(expected, encoding);
  if (decoded === null) return false;
  const actual = createHmac(algorithm, toBytes(key)).update(toBytes(input)).digest();
  return actual.length === decoded.length && timingSafeEqual(actual, decoded);
}

/** Constant time and length-blind: both sides are MACed under a fresh key first. */
export function constantTimeEqual(a: CryptoInput, b: CryptoInput): boolean {
  const key = randomBytes(32);
  const left = createHmac("sha256", key).update(toBytes(a)).digest();
  const right = createHmac("sha256", key).update(toBytes(b)).digest();
  return timingSafeEqual(left, right);
}

/** HKDF (RFC 5869). Salt and info default to empty. */
export function deriveKey(
  secret: CryptoInput,
  options: {
    salt?: CryptoInput;
    info?: CryptoInput;
    length?: number;
    hash?: DigestAlgorithm;
    encoding?: ByteEncoding;
  } = {},
): string {
  const hash = options.hash ?? "sha256";
  const length = options.length ?? 32;
  const max = 255 * DIGEST_LENGTH[hash];
  if (!Number.isInteger(length) || length < 1 || length > max) {
    throw new InvokeError("ERR_INPUT_INVALID", `length must be an integer from 1 to ${max} for ${hash}.`);
  }
  const key = hkdfSync(
    hash,
    toBytes(secret),
    toBytes(options.salt ?? ""),
    toBytes(options.info ?? ""),
    length,
  );
  return encodeBytes(new Uint8Array(key), options.encoding ?? "base64url");
}

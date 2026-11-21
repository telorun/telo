import { randomBytes } from "node:crypto";

export const SECRET_SEED_BYTES = 32;

export type SecretSeed = Uint8Array;

/** Where a seed text came from: names the source in a refusal, never the value. */
export type SecretSeedSource = { variable: string } | { file: string };

export class SecretSeedError extends Error {
  constructor(
    message: string,
    readonly source: SecretSeedSource,
  ) {
    super(message);
    this.name = "SecretSeedError";
  }
}

const SEED_TEXT = /^[A-Za-z0-9_-]{43}$/;

export function encodeSecretSeed(seed: SecretSeed): string {
  if (seed.length !== SECRET_SEED_BYTES) {
    throw new RangeError(`a secret seed is ${SECRET_SEED_BYTES} bytes`);
  }
  return Buffer.from(seed).toString("base64url");
}

export function refusalSentence(source: SecretSeedSource): string {
  return "variable" in source
    ? `${source.variable} must be 32 bytes of unpadded base64url`
    : `${source.file} does not hold 32 bytes of unpadded base64url`;
}

export function decodeSecretSeed(text: string, source: SecretSeedSource): SecretSeed {
  if (SEED_TEXT.test(text)) {
    const bytes = Buffer.from(text, "base64url");
    // The 43rd character carries two spare bits that must be zero.
    if (bytes.length === SECRET_SEED_BYTES && bytes.toString("base64url") === text) {
      return new Uint8Array(bytes);
    }
  }
  throw new SecretSeedError(refusalSentence(source), source);
}

export function generateSecretSeed(): SecretSeed {
  return new Uint8Array(randomBytes(SECRET_SEED_BYTES));
}

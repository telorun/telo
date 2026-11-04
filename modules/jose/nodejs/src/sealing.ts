import { decodeBytes, deriveKey, digest } from "@telorun/crypto";
import { CompactEncrypt, compactDecrypt, decodeProtectedHeader, errors } from "jose";

/** A 256-bit content key derived from a secret, and the id its tokens carry. */
export interface SealingKey {
  kid: string;
  key: Uint8Array;
}

const SALT = "telo.jose";

/** The purpose `Jose.Encrypt` / `Jose.Decrypt` derive their key for. */
export const SEALING_PURPOSE = "sealed-value";

/** HKDF-SHA-256 of `secret` for one purpose; the kid is a digest prefix of the derived key. */
export function sealingKey(secret: string, purpose: string): SealingKey {
  const key = decodeBytes(deriveKey(secret, { salt: SALT, info: purpose, length: 32, encoding: "hex" }), "hex")!;
  return { kid: digest(key, "sha256", "base64url").slice(0, 16), key };
}

/** JWE compact, `dir` with A256GCM. */
export function seal(plaintext: string, key: SealingKey): Promise<string> {
  return new CompactEncrypt(new TextEncoder().encode(plaintext))
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: key.kid })
    .encrypt(key.key);
}

export type UnsealRefusal = "malformed" | "unknownKey" | "decryption";
export type Unsealed = { ok: true; plaintext: string } | { ok: false; reason: UnsealRefusal };

/** Opens a token sealed under any of `keys`, chosen by the token's kid. */
export async function unseal(token: string, keys: SealingKey[]): Promise<Unsealed> {
  if (typeof token !== "string" || token.split(".").length !== 5) return { ok: false, reason: "malformed" };
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "dir" || header.enc !== "A256GCM" || typeof header.kid !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const key = keys.find((candidate) => candidate.kid === header.kid);
  if (!key) return { ok: false, reason: "unknownKey" };
  try {
    const { plaintext } = await compactDecrypt(token, key.key, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    return { ok: true, plaintext: new TextDecoder().decode(plaintext) };
  } catch (err) {
    if (err instanceof errors.JWEDecryptionFailed) return { ok: false, reason: "decryption" };
    if (err instanceof errors.JOSEError) return { ok: false, reason: "malformed" };
    throw err;
  }
}

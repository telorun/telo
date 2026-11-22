import { createHmac, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { RuntimeError } from "@telorun/sdk";

export type KeyAlgorithm = "hmac-sha256" | "ed25519";

/** One entry of the verifier's `keys`, as written. */
export interface KeyResource {
  id?: string;
  subject: string;
  algorithm: KeyAlgorithm;
  secret?: string | Uint8Array;
  jwk?: { kty: string; crv: string; x: string; kid?: string };
}

/** A key ready to check signatures with. */
export interface SignatureKey {
  id: string | null;
  subject: string;
  algorithm: KeyAlgorithm;
  /** Whether `signature` is a valid signature of `base` under this key. */
  check(base: Uint8Array, signature: Uint8Array): boolean;
}

export function prepareKey(entry: KeyResource, describe: string): SignatureKey {
  const common = { id: entry.id ?? null, subject: entry.subject, algorithm: entry.algorithm };
  if (entry.algorithm === "hmac-sha256") {
    const secret = typeof entry.secret === "string" ? new TextEncoder().encode(entry.secret) : entry.secret;
    if (!(secret instanceof Uint8Array) || secret.length === 0) {
      throw new RuntimeError("ERR_INVALID_VALUE", `${describe}: a hmac-sha256 key needs a non-empty 'secret'.`);
    }
    return {
      ...common,
      check(base, signature) {
        const expected = createHmac("sha256", secret).update(base).digest();
        return signature.length === expected.length && timingSafeEqual(expected, signature);
      },
    };
  }
  if (entry.algorithm === "ed25519") {
    const jwk = entry.jwk;
    if (jwk === undefined || jwk === null) {
      throw new RuntimeError("ERR_INVALID_VALUE", `${describe}: an ed25519 key needs a 'jwk'.`);
    }
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: "jwk" });
    } catch (cause) {
      throw new RuntimeError("ERR_INVALID_VALUE", `${describe}: 'jwk' is not an Ed25519 public key (${(cause as Error).message}).`);
    }
    return { ...common, check: (base, signature) => verify(null, base, publicKey, signature) };
  }
  throw new RuntimeError("ERR_INVALID_VALUE", `${describe}: algorithm '${String(entry.algorithm)}' is not supported.`);
}

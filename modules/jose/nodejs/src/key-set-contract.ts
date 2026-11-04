import type { JWK } from "jose";

/**
 * The key-set instance contract (`exports.code: @telorun/jose`): what a
 * `Jose.Keys` resource is to a controller holding it through a reference slot.
 * An instance is recognised by these methods alone, never by its class.
 */

/** A key `jose` signs or verifies with: a WebCrypto key, or the raw bytes of an HMAC secret. */
export type KeyMaterial = CryptoKey | Uint8Array;

/** What a token's protected header says about the key that signed it. */
export interface KeyHint {
  alg: string;
  kid?: string;
}

export interface JsonWebKeySet {
  keys: JWK[];
}

/** Something that yields verification keys. */
export interface JoseKeys {
  /**
   * Every key that may have signed a token with this header, compatible with its
   * `alg` and matching its `kid` when it has one. Empty when the set holds none,
   * which a verifier reports as an unknown key. Rejects with
   * `ERR_JOSE_KEYSET_UNAVAILABLE` / `ERR_JOSE_REMOTE_KEYS_UNREACHABLE` when the
   * keys cannot be reached.
   */
  verificationKeys(hint: KeyHint, signal?: AbortSignal): Promise<KeyMaterial[]>;
  /** The public JWKS of every key still verifying; empty for a symmetric set. */
  publicKeys(signal?: AbortSignal): Promise<JsonWebKeySet>;
}

export interface SigningKey {
  kid: string;
  alg: string;
  key: KeyMaterial;
}

export interface RotationOutcome {
  /** Whether this call made a new key current. */
  rotated: boolean;
  currentKid: string;
  /** Keys this call removed because their retirement time had passed. */
  retiredKids: string[];
}

/** A local signing key set. */
export interface JoseKeySet extends JoseKeys {
  /** The current signing key. */
  signingKey(): Promise<SigningKey>;
  /**
   * Make a new key current when one is due (always, with `force`), and remove
   * keys past their retirement. A static set rejects with
   * `ERR_JOSE_KEYSET_UNAVAILABLE`.
   */
  rotate(force: boolean): Promise<RotationOutcome>;
}

export function isJoseKeys(value: unknown): value is JoseKeys {
  const candidate = value as Partial<JoseKeys> | null | undefined;
  return (
    !!candidate &&
    typeof candidate.verificationKeys === "function" &&
    typeof candidate.publicKeys === "function"
  );
}

export function isJoseKeySet(value: unknown): value is JoseKeySet {
  const candidate = value as Partial<JoseKeySet> | null | undefined;
  return (
    isJoseKeys(value) &&
    typeof candidate!.signingKey === "function" &&
    typeof candidate!.rotate === "function"
  );
}

export const ERR_JOSE_KEYSET_UNAVAILABLE = "ERR_JOSE_KEYSET_UNAVAILABLE";
export const ERR_JOSE_REMOTE_KEYS_UNREACHABLE = "ERR_JOSE_REMOTE_KEYS_UNREACHABLE";
export const ERR_JOSE_ALGORITHM_UNSUPPORTED = "ERR_JOSE_ALGORITHM_UNSUPPORTED";

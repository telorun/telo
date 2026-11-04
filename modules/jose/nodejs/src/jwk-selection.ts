import { importJWK, type JWK } from "jose";
import type { KeyHint, KeyMaterial } from "./key-set-contract.js";

/** The algorithms a local key set signs with. */
export const SIGNING_ALGORITHMS = ["ES256", "RS256", "EdDSA", "HS256"] as const;
export type SigningAlgorithm = (typeof SIGNING_ALGORITHMS)[number];

interface KeyFamily {
  kty: string;
  crv?: string;
}

const FAMILIES: Record<string, KeyFamily> = {
  ES256: { kty: "EC", crv: "P-256" },
  ES384: { kty: "EC", crv: "P-384" },
  ES512: { kty: "EC", crv: "P-521" },
  RS256: { kty: "RSA" },
  RS384: { kty: "RSA" },
  RS512: { kty: "RSA" },
  PS256: { kty: "RSA" },
  PS384: { kty: "RSA" },
  PS512: { kty: "RSA" },
  EdDSA: { kty: "OKP", crv: "Ed25519" },
  HS256: { kty: "oct" },
  HS384: { kty: "oct" },
  HS512: { kty: "oct" },
};

const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;

export function isSymmetric(alg: string): boolean {
  return FAMILIES[alg]?.kty === "oct";
}

/** Whether `jwk` is a key of the type `alg` signs with, and does not restrict itself to another use. */
export function servesAlgorithm(jwk: JWK, alg: string): boolean {
  const family = FAMILIES[alg];
  if (!family || jwk.kty !== family.kty) return false;
  if (family.crv !== undefined && jwk.crv !== family.crv) return false;
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  if (jwk.use !== undefined && jwk.use !== "sig") return false;
  return true;
}

/** Whether the JWK carries private material it can sign with. */
export function isPrivate(jwk: JWK): boolean {
  return jwk.kty === "oct" ? typeof jwk.k === "string" : typeof jwk.d === "string";
}

/** `jwk` without its private members. */
export function publicPart(jwk: JWK): JWK {
  const copy: Record<string, unknown> = { ...jwk };
  for (const member of PRIVATE_MEMBERS) delete copy[member];
  delete copy.key_ops;
  delete copy.ext;
  return copy as JWK;
}

/** The public half of an asymmetric JWK, labelled for signature verification. */
export function publicJwk(jwk: JWK, kid: string, alg: string): JWK {
  return { ...publicPart(jwk), kid, alg, use: "sig" };
}

/** The keys of `jwks` that may have signed a token with this header. */
export function selectKeys<T extends { jwk: JWK; kid: string }>(keys: T[], hint: KeyHint): T[] {
  return keys.filter(
    (entry) => servesAlgorithm(entry.jwk, hint.alg) && (hint.kid === undefined || entry.kid === hint.kid),
  );
}

/**
 * Imports keys once per (key, algorithm). Keyed by the JWK object itself, so a
 * replaced set drops its imports with it.
 */
export class KeyImports {
  private readonly imported = new WeakMap<object, Map<string, Promise<KeyMaterial>>>();

  get(jwk: JWK, alg: string): Promise<KeyMaterial> {
    let byAlg = this.imported.get(jwk);
    if (!byAlg) {
      byAlg = new Map();
      this.imported.set(jwk, byAlg);
    }
    let key = byAlg.get(alg);
    if (!key) {
      key = importJWK(jwk, alg) as Promise<KeyMaterial>;
      key.catch(() => byAlg!.delete(alg));
      byAlg.set(alg, key);
    }
    return key;
  }
}

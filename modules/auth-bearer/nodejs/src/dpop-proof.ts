import { createHash } from "node:crypto";
import { calculateJwkThumbprint, decodeProtectedHeader, errors, importJWK, jwtVerify, type JWK } from "jose";
import { isRecord } from "./claim-readers.js";

export interface DpopSettings {
  /** Signature algorithms a proof may use. */
  algorithms: string[];
  maxProofAgeMs: number;
}

export interface DpopRequest {
  proof: string;
  method: string;
  uri: string;
}

export type DpopOutcome = { valid: true; jkt: string; jti: string } | { valid: false };

/** `base64url(SHA-256(value))`, the `ath` and certificate-thumbprint encoding. */
export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

// RFC 9449 §4.3: the request URI without query and fragment, compared after
// scheme and host normalization.
function targetOf(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  try {
    const url = new URL(uri);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

/**
 * Judges a DPoP proof (RFC 9449 §4.3) for `accessToken`: type, algorithm,
 * embedded public key, signature, `htm`, `htu`, `iat` within the allowed age,
 * `ath`, and that its key's thumbprint is `expectedJkt`. Every failure is the
 * same outcome; the caller refuses.
 */
export async function checkDpopProof(
  request: DpopRequest,
  accessToken: string,
  expectedJkt: string,
  settings: DpopSettings,
  nowMs: number,
): Promise<DpopOutcome> {
  const invalid: DpopOutcome = { valid: false };
  try {
    const header = decodeProtectedHeader(request.proof);
    const jwk = header.jwk as JWK | undefined;
    if (typeof header.alg !== "string" || !settings.algorithms.includes(header.alg)) return invalid;
    if (!isRecord(jwk) || "d" in jwk || jwk.kty === "oct") return invalid;

    const key = await importJWK(jwk, header.alg);
    const { payload } = await jwtVerify(request.proof, key, {
      algorithms: [header.alg],
      typ: "dpop+jwt",
    });

    if (typeof payload.jti !== "string" || payload.jti === "") return invalid;
    if (typeof payload.iat !== "number" || Math.abs(nowMs - payload.iat * 1000) > settings.maxProofAgeMs) {
      return invalid;
    }
    if (payload.htm !== request.method) return invalid;
    const target = targetOf(request.uri);
    if (target === null || targetOf(payload.htu) !== target) return invalid;
    if (payload.ath !== sha256Base64Url(accessToken)) return invalid;
    const jkt = await calculateJwkThumbprint(jwk);
    if (jkt !== expectedJkt) return invalid;
    return { valid: true, jkt, jti: payload.jti };
  } catch (err) {
    // A proof the library cannot read is an invalid proof; anything else is a fault.
    if (err instanceof errors.JOSEError || err instanceof TypeError) return invalid;
    throw err;
  }
}

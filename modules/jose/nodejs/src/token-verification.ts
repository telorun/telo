import { decodeProtectedHeader, errors, jwtVerify, type JWTPayload, type ProtectedHeaderParameters } from "jose";
import type { JoseKeys } from "./key-set-contract.js";

export type RefusalReason =
  | "malformed"
  | "algorithm"
  | "unknownKey"
  | "signature"
  | "expired"
  | "notBefore"
  | "issuer"
  | "audience"
  | "type"
  | "claims";

export type VerifyOutcome =
  | { valid: true; payload: JWTPayload; header: ProtectedHeaderParameters }
  | { valid: false; reason: RefusalReason };

export interface VerifyPolicy {
  /** The only algorithms accepted; never taken from the token. */
  algorithms: string[];
  issuer?: string | string[];
  audience?: string | string[];
  /** Matched against the `typ` header. */
  type?: string;
  clockToleranceSeconds?: number;
  maxTokenAgeSeconds?: number;
  requiredClaims?: string[];
}

/**
 * Verifies a compact JWS JWT against `keys`. Every refusal is a returned
 * outcome; only a failure to reach the keys rejects.
 */
export async function verifyToken(
  keys: JoseKeys,
  token: string,
  policy: VerifyPolicy,
  signal?: AbortSignal,
): Promise<VerifyOutcome> {
  if (typeof token !== "string" || token.split(".").length !== 3) return refuse("malformed");
  let header: ProtectedHeaderParameters;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return refuse("malformed");
  }
  const alg = header.alg;
  if (typeof alg !== "string") return refuse("malformed");
  if (!policy.algorithms.includes(alg)) return refuse("algorithm");
  if (header.kid !== undefined && typeof header.kid !== "string") return refuse("malformed");

  const candidates = await keys.verificationKeys({ alg, kid: header.kid }, signal);
  if (candidates.length === 0) return refuse("unknownKey");

  for (const key of candidates) {
    try {
      const verified = await jwtVerify(token, key, {
        algorithms: [alg],
        issuer: policy.issuer,
        audience: policy.audience,
        typ: policy.type,
        clockTolerance: policy.clockToleranceSeconds,
        maxTokenAge: policy.maxTokenAgeSeconds,
        requiredClaims: policy.requiredClaims,
      });
      return { valid: true, payload: verified.payload, header: verified.protectedHeader };
    } catch (err) {
      if (err instanceof errors.JWSSignatureVerificationFailed) continue;
      const reason = refusalOf(err);
      if (reason === null) throw err;
      return refuse(reason);
    }
  }
  return refuse("signature");
}

function refuse(reason: RefusalReason): VerifyOutcome {
  return { valid: false, reason };
}

const CLAIM_REASONS: Record<string, RefusalReason> = {
  nbf: "notBefore",
  iss: "issuer",
  aud: "audience",
  typ: "type",
};

function refusalOf(err: unknown): RefusalReason | null {
  if (err instanceof errors.JWTExpired) return "expired";
  if (err instanceof errors.JWTClaimValidationFailed) {
    return err.reason === "invalid" ? "claims" : (CLAIM_REASONS[err.claim] ?? "claims");
  }
  if (err instanceof errors.JOSEAlgNotAllowed) return "algorithm";
  if (
    err instanceof errors.JWSInvalid ||
    err instanceof errors.JWTInvalid ||
    err instanceof errors.JOSENotSupported
  ) {
    return "malformed";
  }
  return null;
}

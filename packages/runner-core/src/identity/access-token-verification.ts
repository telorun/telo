import { decodeJwt, decodeProtectedHeader, errors, jwtVerify, type JWTPayload } from "jose";

import { IdentityRefusal } from "./identity-refusal.js";
import type { IssuerKeys } from "./issuer-keys.js";

/** Skew allowed on `exp`, `nbf` and `iat`. */
const ACCESS_TOKEN_SKEW_S = 60;

/** Signature algorithms with a public verification key: anything symmetric, or
 *  `none`, could only be checked with a secret the runner does not hold. */
const ASYMMETRIC_ALGS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
  "Ed25519",
];

export interface VerifiedAccessToken {
  iss: string;
  sub: string;
  /** `cnf.jkt`: the thumbprint of the key the token is bound to. */
  jkt: string;
}

export interface AccessTokenExpectations {
  audience: string;
  issuers: readonly string[];
  keys: IssuerKeys;
  now: () => number;
}

/** An RFC 9068 JWT access token, DPoP-bound, for this runner's audience. */
export async function verifyAccessToken(
  token: string,
  expected: AccessTokenExpectations,
): Promise<VerifiedAccessToken> {
  const header = decoded(() => decodeProtectedHeader(token));
  if (typeof header.typ !== "string" || mediaType(header.typ) !== "at+jwt") {
    throw refused(`the access token's 'typ' is '${String(header.typ)}', not 'at+jwt'`);
  }
  if (typeof header.alg !== "string" || !ASYMMETRIC_ALGS.includes(header.alg)) {
    throw refused(`the access token's 'alg' '${String(header.alg)}' is not an asymmetric signature algorithm`);
  }
  const unverified = decoded(() => decodeJwt(token));
  const iss = unverified.iss;
  if (typeof iss !== "string" || !expected.issuers.includes(iss)) {
    throw refused(`the access token's issuer '${String(iss)}' is not one this runner accepts`);
  }

  const options = {
    issuer: iss,
    audience: expected.audience,
    algorithms: ASYMMETRIC_ALGS,
    typ: "at+jwt",
    clockTolerance: ACCESS_TOKEN_SKEW_S,
    currentDate: new Date(expected.now()),
    requiredClaims: ["exp", "sub"],
  };
  let payload: JWTPayload;
  try {
    payload = (await jwtVerify(token, await expected.keys.lookup(iss), options)).payload;
  } catch (err) {
    if (!(err instanceof errors.JWKSNoMatchingKey)) throw judged(err);
    const refreshed = await expected.keys.refreshForUnknownKey(iss);
    if (!refreshed) throw refused("the access token is signed by a key the issuer does not publish");
    try {
      payload = (await jwtVerify(token, refreshed, options)).payload;
    } catch (retried) {
      throw judged(retried);
    }
  }

  if (payload.iat !== undefined && payload.iat > expected.now() / 1000 + ACCESS_TOKEN_SKEW_S) {
    throw refused("the access token's 'iat' is in the future");
  }
  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw refused("the access token carries no 'sub'");
  }
  const jkt = (payload.cnf as { jkt?: unknown } | undefined)?.jkt;
  if (typeof jkt !== "string" || jkt === "") {
    throw refused("the access token is not DPoP-bound: it carries no 'cnf.jkt'");
  }
  return { iss, sub: payload.sub, jkt };
}

/** `typ` compares case-insensitively, with or without `application/` (RFC 7515 §4.1.9). */
export function mediaType(typ: string): string {
  const lower = typ.toLowerCase();
  return lower.startsWith("application/") ? lower.slice("application/".length) : lower;
}

/** Decoding reads the token alone, so whatever it throws is the token's fault. */
function decoded<T>(read: () => T): T {
  try {
    return read();
  } catch (err) {
    throw refused(`the access token is not a JWT: ${(err as Error).message}`);
  }
}

/** jose's refusals are the token's; anything else is the runner's own failure. */
function judged(err: unknown): unknown {
  if (err instanceof errors.JOSEError) return refused(`the access token is refused: ${err.message}`);
  return err;
}

function refused(message: string): IdentityRefusal {
  return new IdentityRefusal("invalid_token", message);
}

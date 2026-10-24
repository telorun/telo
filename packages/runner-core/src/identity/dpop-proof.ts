import { createHash } from "node:crypto";

import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  errors,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";

import { mediaType } from "./access-token-verification.js";
import { IdentityRefusal } from "./identity-refusal.js";
import { DPOP_SIGNING_ALGS } from "./protected-resource-metadata.js";

/** How far a proof's `iat` may be from now, either way. */
export const DPOP_PROOF_WINDOW_S = 120;

const MAX_JTI_LENGTH = 256;

export interface DpopRequest {
  /** The request method, compared to `htm` exactly. */
  method: string;
  /** The audience followed by the request path, without its query. */
  htu: string;
  accessToken: string;
  /** The access token's `cnf.jkt`. */
  jkt: string;
  now: () => number;
}

export interface VerifiedDpopProof {
  jti: string;
  /** Until when the `jti` must be remembered: after it, `iat` refuses the
   *  proof on its own. */
  replayableUntil: Date;
}

/** An RFC 9449 DPoP proof for this request, by the key the token is bound to.
 *  Its `jti` is checked unseen by the caller, which holds the store. */
export async function verifyDpopProof(proof: string, request: DpopRequest): Promise<VerifiedDpopProof> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(proof);
  } catch (err) {
    throw refused(`the DPoP proof is not a JWT: ${(err as Error).message}`);
  }
  if (typeof header.typ !== "string" || mediaType(header.typ) !== "dpop+jwt") {
    throw refused(`the DPoP proof's 'typ' is '${String(header.typ)}', not 'dpop+jwt'`);
  }
  const alg = header.alg;
  if (typeof alg !== "string" || !(DPOP_SIGNING_ALGS as readonly string[]).includes(alg)) {
    throw refused(
      `the DPoP proof's 'alg' '${String(alg)}' is not one this runner verifies (${DPOP_SIGNING_ALGS.join(", ")})`,
    );
  }
  const jwk = header.jwk as JWK | undefined;
  if (jwk === null || typeof jwk !== "object" || Array.isArray(jwk)) {
    throw refused("the DPoP proof carries no 'jwk'");
  }
  if ("d" in jwk) throw refused("the DPoP proof's 'jwk' is a private key");

  let key: Awaited<ReturnType<typeof importJWK>>;
  let thumbprint: string;
  try {
    key = await importJWK(jwk, alg);
    thumbprint = await calculateJwkThumbprint(jwk, "sha256");
  } catch (err) {
    throw refused(`the DPoP proof's 'jwk' is not a usable public key: ${(err as Error).message}`);
  }
  if (thumbprint !== request.jkt) {
    throw refused("the DPoP proof is signed by a key other than the one the access token is bound to");
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(proof, key, {
      algorithms: [...DPOP_SIGNING_ALGS],
      typ: "dpop+jwt",
      currentDate: new Date(request.now()),
      requiredClaims: ["jti", "htm", "htu", "iat"],
    }));
  } catch (err) {
    if (err instanceof errors.JOSEError) throw refused(`the DPoP proof is refused: ${err.message}`);
    throw err;
  }

  if (payload.htm !== request.method) {
    throw refused(`the DPoP proof's 'htm' is '${String(payload.htm)}', but the request is ${request.method}`);
  }
  const htu = typeof payload.htu === "string" ? withoutQuery(payload.htu) : undefined;
  if (htu === undefined || htu !== withoutQuery(request.htu)) {
    throw refused(`the DPoP proof's 'htu' is '${String(payload.htu)}', but the request is for ${request.htu}`);
  }
  const iat = payload.iat!;
  if (Math.abs(request.now() / 1000 - iat) > DPOP_PROOF_WINDOW_S) {
    throw refused(`the DPoP proof's 'iat' is more than ${DPOP_PROOF_WINDOW_S} s from now`);
  }
  const expectedAth = createHash("sha256").update(request.accessToken, "ascii").digest("base64url");
  if (payload.ath !== expectedAth) {
    throw refused("the DPoP proof's 'ath' is not the hash of the access token it accompanies");
  }
  const jti = payload.jti;
  if (typeof jti !== "string" || jti === "" || jti.length > MAX_JTI_LENGTH) {
    throw refused(`the DPoP proof's 'jti' must be a non-empty string of at most ${MAX_JTI_LENGTH} characters`);
  }
  return { jti, replayableUntil: new Date((iat + DPOP_PROOF_WINDOW_S + 1) * 1000) };
}

/** An `htu` compared as RFC 9449 §4.3 says: its query and fragment ignored,
 *  scheme, host and default port normalized. */
function withoutQuery(htu: string): string | undefined {
  try {
    const url = new URL(htu);
    return url.origin + url.pathname;
  } catch {
    return undefined;
  }
}

function refused(message: string): IdentityRefusal {
  return new IdentityRefusal("invalid_dpop_proof", message);
}

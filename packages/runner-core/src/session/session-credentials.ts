import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";

import { IdentityProviderUnavailable, IdentityRefusal } from "../identity/identity-refusal.js";
import type { IdentityVerifier } from "../identity/identity-verifier.js";
import type { SessionOwner } from "../session-store/session-store.js";

/**
 * Who is calling, resolved from a request's credentials — the ONE place a
 * session route learns it. A resume secret (`Authorization: Bearer <secret>`)
 * resolves to the owner `{ kind: "secret", secretHash }`; on a runner configured
 * for identity, `Authorization: DPoP <token>` with its `DPoP` proof resolves to
 * `{ kind: "identity", iss, sub }`. Every route asks this same question.
 */
export type Caller = { kind: "anonymous" } | { kind: "owner"; owner: SessionOwner };

/** A request whose credentials are refused outright, answered as is. */
export interface CredentialRefusal {
  status: number;
  error: string;
  message: string;
  headers?: Record<string, string>;
}

export type CallerResult = { caller: Caller } | { refusal: CredentialRefusal };

export type CallerResolver = (req: FastifyRequest) => Promise<CallerResult>;

/** 256 bits: the secret is the whole credential of an anonymous session. */
const RESUME_SECRET_BYTES = 32;

/** A fresh resume secret and the owner that stores it — its SHA-256 only. */
export function mintResumeSecret(): { secret: string; owner: SessionOwner } {
  const secret = randomBytes(RESUME_SECRET_BYTES).toString("base64url");
  return { secret, owner: { kind: "secret", secretHash: resumeSecretHash(secret) } };
}

export function resumeSecretHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

const BEARER = /^Bearer\s+(\S+)\s*$/i;
const DPOP = /^DPoP\s+(\S+)\s*$/i;

export interface CallerResolverOptions {
  /** Set on a runner configured for identity: `Authorization: DPoP` resolves
   *  to the token's `(iss, sub)`. */
  identity?: IdentityVerifier;
}

/** The caller a request's `Authorization` header names. */
export function callerResolver(options: CallerResolverOptions = {}): CallerResolver {
  const identity = options.identity;
  return async (req) => {
    const header = req.headers.authorization;
    if (header === undefined || header.trim() === "") return { caller: { kind: "anonymous" } };
    const bearer = BEARER.exec(header);
    if (bearer) {
      return {
        caller: { kind: "owner", owner: { kind: "secret", secretHash: resumeSecretHash(bearer[1]!) } },
      };
    }
    const dpop = DPOP.exec(header);
    if (identity && dpop) return identityCaller(identity, req, dpop[1]!);
    return {
      refusal: {
        status: 401,
        error: "session_auth_required",
        message: identity
          ? "this runner takes a session's resume secret as `Authorization: Bearer <secret>`, or an " +
            "identity as `Authorization: DPoP <access token>` with a `DPoP` proof"
          : "this runner takes a session's resume secret as `Authorization: Bearer <secret>`, " +
            "and no other credential",
        ...(identity ? { headers: { "www-authenticate": identity.challenge() } } : {}),
      },
    };
  };
}

async function identityCaller(
  identity: IdentityVerifier,
  req: FastifyRequest,
  token: string,
): Promise<CallerResult> {
  try {
    const { iss, sub } = await identity.verify(req, token);
    return { caller: { kind: "owner", owner: { kind: "identity", iss, sub } } };
  } catch (err) {
    if (err instanceof IdentityRefusal) {
      return {
        refusal: {
          status: 401,
          error: err.code,
          message: err.message,
          headers: { "www-authenticate": identity.challenge(err) },
        },
      };
    }
    if (err instanceof IdentityProviderUnavailable) {
      return {
        refusal: {
          status: 503,
          error: "identity_provider_unavailable",
          message: `the issuer '${err.issuer}' cannot be reached for its keys: ${err.message}`,
        },
      };
    }
    throw err;
  }
}

/** Whether `caller` owns a session owned by `owner`. */
export function ownsSession(caller: SessionOwner, owner: SessionOwner): boolean {
  if (caller.kind === "secret" && owner.kind === "secret") {
    return timingSafeEqual(Buffer.from(caller.secretHash), Buffer.from(owner.secretHash));
  }
  if (caller.kind === "identity" && owner.kind === "identity") {
    return caller.iss === owner.iss && caller.sub === owner.sub;
  }
  return false;
}

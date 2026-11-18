import type { FastifyReply, FastifyRequest } from "fastify";

import type { CallerResolver } from "../session/session-credentials.js";
import type { SessionOwner } from "../session-store/session-store.js";

/** What a route needs to ask who is calling. */
export interface CallerGateDeps {
  resolveCaller: CallerResolver;
  /** `WWW-Authenticate` on a 401 for a missing credential, on a runner that
   *  takes identity. */
  authChallenge?: string;
}

/**
 * The identity a request carries, for a route only an identity may use. No
 * credential is `401 session_auth_required`; a resume secret is
 * `403 identity_required`, since it names one session rather than an owner.
 */
export async function identityOwner(
  deps: CallerGateDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  what: string,
): Promise<Extract<SessionOwner, { kind: "identity" }> | undefined> {
  const resolved = await deps.resolveCaller(req);
  if ("refusal" in resolved) {
    refuse(reply, resolved.refusal);
    return undefined;
  }
  if (resolved.caller.kind === "anonymous") {
    authRequired(deps, reply, `${what} takes an identity`);
    return undefined;
  }
  if (resolved.caller.owner.kind !== "identity") {
    reply.code(403).send({
      error: "identity_required",
      message: deps.authChallenge
        ? `${what} takes an identity — \`Authorization: DPoP <access token>\` with a \`DPoP\` proof — ` +
          "not a resume secret"
        : `${what} takes an identity, and this runner accepts none (see /v1/capabilities)`,
    });
    return undefined;
  }
  return resolved.caller.owner;
}

export function authRequired(deps: CallerGateDeps, reply: FastifyReply, what: string): void {
  if (deps.authChallenge) reply.header("www-authenticate", deps.authChallenge);
  reply.code(401).send({
    error: "session_auth_required",
    message: deps.authChallenge
      ? `${what}: \`Authorization: Bearer <resume secret>\`, or \`Authorization: DPoP <access token>\` ` +
        "with a `DPoP` proof"
      : `${what}: \`Authorization: Bearer <resume secret>\``,
  });
}

export function refuse(
  reply: FastifyReply,
  refusal: { status: number; error: string; message: string; headers?: Record<string, string> },
): void {
  if (refusal.headers) reply.headers(refusal.headers);
  reply.code(refusal.status).send({ error: refusal.error, message: refusal.message });
}

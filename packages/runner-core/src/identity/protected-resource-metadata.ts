import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { IdentityConfig } from "../config.js";
import type { ProtectedResourceMetadata } from "../contract.js";
import type { IdentityErrorCode } from "./identity-refusal.js";

/** The DPoP proof algorithms the runner verifies, and advertises. */
export const DPOP_SIGNING_ALGS = ["ES256", "EdDSA"] as const;

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

export function protectedResourceMetadata(config: IdentityConfig): ProtectedResourceMetadata {
  return {
    resource: config.audience,
    authorization_servers: [...config.issuers],
    dpop_bound_access_tokens_required: true,
    dpop_signing_alg_values_supported: [...DPOP_SIGNING_ALGS],
  };
}

/** Where a client fetches the metadata: RFC 9728 §3.1 inserts the well-known
 *  segment between the audience's origin and its path. */
export function protectedResourceMetadataUrl(audience: string): string {
  const url = new URL(audience);
  return url.origin + WELL_KNOWN + audiencePath(url);
}

/** `WWW-Authenticate` for a 401 on a runner that takes identity. */
export function dpopChallenge(
  metadataUrl: string,
  error?: { code: IdentityErrorCode; description: string },
): string {
  const params = error
    ? [`error="${error.code}"`, `error_description="${quotable(error.description)}"`]
    : [];
  params.push(`algs="${DPOP_SIGNING_ALGS.join(" ")}"`, `resource_metadata="${metadataUrl}"`);
  return `DPoP ${params.join(", ")}`;
}

/**
 * Serves the metadata at the RFC 9728 path for the audience and at the bare
 * well-known path: a runner mounted under a path sees whichever one its proxy
 * forwards, and both name the same resource.
 */
export function protectedResourceMetadataRoute(
  metadata: ProtectedResourceMetadata,
): FastifyPluginAsync {
  const paths = new Set([WELL_KNOWN, WELL_KNOWN + audiencePath(new URL(metadata.resource))]);
  return async (app: FastifyInstance) => {
    for (const path of paths) app.get(path, async () => metadata);
  };
}

function audiencePath(url: URL): string {
  return url.pathname === "/" ? "" : url.pathname;
}

/** An auth-param quoted-string carries no `"` or `\`, and stays printable. */
function quotable(text: string): string {
  return text.replace(/["\\]/g, "'").replace(/[^\x20-\x7e]/g, " ");
}

/**
 * Whether a runner session is reached with the signed-in identity or with a
 * resume secret kept on this device.
 *
 * A runner advertises the identity it accepts as RFC 9728 metadata on its
 * capabilities. Studio never takes the advertised `resource` as the audience to
 * ask a token for: it checks that it IS the address Studio connects to. A
 * runner advertising another runner's address would otherwise collect a token
 * that works there.
 */

/** `identity` on `/v1/capabilities`: RFC 9728 protected-resource metadata. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  dpop_bound_access_tokens_required?: boolean;
  dpop_signing_alg_values_supported?: string[];
}

export type IdentityEligibility =
  | { use: true; resource: string }
  /** `reason` says why a signed-in user's identity is not used on a runner
   *  that advertises one; null when there is nothing to explain (signed out,
   *  or a runner that takes resume secrets only). */
  | { use: false; reason: string | null };

export interface IdentityEligibilityInput {
  signedIn: boolean;
  /** The base URL requests are sent to, as sent. */
  connectedBaseUrl: string;
  /** The runner's advertised `identity`, as read off the wire. */
  identity: unknown;
  /** Studio's own identity provider. */
  issuer: string;
}

export function runnerIdentityEligibility(input: IdentityEligibilityInput): IdentityEligibility {
  if (!input.signedIn) return { use: false, reason: null };
  const fallback = (why: string): IdentityEligibility => ({
    use: false,
    reason: `${why} This workspace's session is reached with a resume secret kept on this device.`,
  });
  // A runner that takes resume secrets only has nothing to explain.
  if (input.identity === undefined || input.identity === null) return { use: false, reason: null };
  const metadata = protectedResourceMetadata(input.identity);
  if (!metadata) return fallback("This runner advertises a sign-in Studio cannot read.");
  if (canonicalHttpsBase(input.connectedBaseUrl) === null) {
    return fallback(`Studio connects to this runner at ${input.connectedBaseUrl}, which is not a canonical https address, so it cannot be a sign-in audience.`);
  }
  if (metadata.resource !== input.connectedBaseUrl) {
    return fallback(
      `This runner's advertised address (${metadata.resource}) does not match the address Studio connects to (${input.connectedBaseUrl}), so no sign-in token is sent to it.`,
    );
  }
  if (!metadata.authorization_servers.includes(input.issuer)) {
    return fallback(`This runner does not accept sign-ins from Studio's identity provider (${input.issuer}).`);
  }
  const algs = metadata.dpop_signing_alg_values_supported;
  if (algs !== undefined && !algs.includes("ES256")) {
    return fallback("This runner does not accept the proof-of-possession algorithm Studio signs with (ES256).");
  }
  return { use: true, resource: metadata.resource };
}

/** The canonical form of an https base URL — origin plus path, no trailing
 *  slash — when `text` is exactly that form; null otherwise. */
export function canonicalHttpsBase(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  const canonical = url.origin + (url.pathname === "/" ? "" : url.pathname);
  return canonical === text && !text.endsWith("/") ? canonical : null;
}

function protectedResourceMetadata(value: unknown): ProtectedResourceMetadata | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.resource !== "string") return null;
  if (!Array.isArray(v.authorization_servers) || !v.authorization_servers.every((s) => typeof s === "string")) {
    return null;
  }
  const algs = v.dpop_signing_alg_values_supported;
  if (algs !== undefined && (!Array.isArray(algs) || !algs.every((a) => typeof a === "string"))) return null;
  return {
    resource: v.resource,
    authorization_servers: v.authorization_servers as string[],
    ...(algs !== undefined ? { dpop_signing_alg_values_supported: algs as string[] } : {}),
  };
}

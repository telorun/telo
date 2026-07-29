import { RuntimeError } from "@telorun/sdk";

/**
 * What a token endpoint hands back, normalized. `expiresAt` is absolute — the
 * server reports a *lifetime*, which stops being meaningful the moment it is
 * stored, so it is resolved against the clock at the point of receipt and never
 * kept as a duration.
 */
export interface TokenSet {
  accessToken: string;
  tokenType: string;
  expiresAt: number | null;
  refreshToken: string | null;
  scope: string | null;
  idToken: string | null;
}

/**
 * An RFC 6749 §5.2 error response. Carried as a typed error rather than a return
 * value because most codes are genuine failures; the few that are legitimate
 * outcomes (`authorization_pending` while a device grant is still being approved,
 * `access_denied` when a user refuses) are branched on by the operation that can
 * act on them, which is the only place that knows they are expected.
 */
export class TokenEndpointError extends RuntimeError {
  constructor(
    readonly error: string,
    readonly description: string | null,
    readonly status: number,
  ) {
    super(
      "ERR_OAUTH_TOKEN_ENDPOINT",
      `Token endpoint returned ${error}${description ? `: ${description}` : ""} (HTTP ${status}).`,
    );
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Normalize a successful token response. A response missing `access_token` is a
 * malformed provider response, not an outcome — it is raised rather than turned
 * into an empty token that would fail confusingly at the next call.
 */
export function parseTokenSet(body: unknown, now: number): TokenSet {
  const payload = body as Record<string, unknown> | null;
  const accessToken = stringOrNull(payload?.access_token);
  if (!accessToken) {
    throw new RuntimeError(
      "ERR_OAUTH_MALFORMED_RESPONSE",
      "Token endpoint returned no access_token. The response did not follow RFC 6749 §5.1.",
    );
  }
  const expiresIn = payload?.expires_in;
  return {
    accessToken,
    tokenType: stringOrNull(payload?.token_type) ?? "Bearer",
    expiresAt: typeof expiresIn === "number" ? now + expiresIn * 1000 : null,
    refreshToken: stringOrNull(payload?.refresh_token),
    scope: stringOrNull(payload?.scope),
    idToken: stringOrNull(payload?.id_token),
  };
}

/** Whether an access token is unusable now, allowing `skewMs` of clock difference. */
export function isExpired(tokens: TokenSet, now: number, skewMs: number): boolean {
  return tokens.expiresAt !== null && tokens.expiresAt - skewMs <= now;
}

import {
  RuntimeError,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { issuerRefusal, requestTokens, scopeParam } from "./token-endpoint.js";
import { isExpired, type TokenSet } from "./token-set.js";
import { resolveSource, type TokenSourceResource } from "./token-source.js";

interface SourceManifest {
  metadata?: { name?: string };
  source: unknown;
}

abstract class SourceOperation implements ResourceInstance {
  protected readonly source: TokenSourceResource;

  constructor(manifest: SourceManifest, ctx: ResourceContext, kind: string) {
    this.source = resolveSource(
      manifest.source,
      ctx,
      () => `OAuthClient.${kind} "${manifest.metadata?.name ?? ""}"`,
    );
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export class TokenExchangeResource extends SourceOperation {
  async invoke(
    inputs: { code: string; redirectUri: string; codeVerifier?: string; iss?: string },
    invokeCtx?: InvokeContext,
  ) {
    // Same issuer check the browser-served callback performs — this is the kind
    // the terminal flow uses, so leaving it out would mean the flow the README
    // leads with had no mix-up defence at all.
    const refusal = issuerRefusal(await this.source.client.endpoints(), inputs.iss);
    if (refusal) {
      throw new RuntimeError(
        refusal === "issuer_missing" ? "ERR_OAUTH_ISSUER_MISSING" : "ERR_OAUTH_ISSUER_MISMATCH",
        refusal === "issuer_missing"
          ? "The authorization server states it returns an 'iss' parameter, but none was passed to the exchange. " +
            "Pass the redirect's `iss` through — dropping it removes the defence against a code minted by another server."
          : `The authorization response came from a different issuer than the one declared. Refusing to exchange the code.`,
      );
    }

    const params: Record<string, string> = {
      grant_type: "authorization_code",
      code: inputs.code,
      redirect_uri: inputs.redirectUri,
    };
    if (inputs.codeVerifier) params.code_verifier = inputs.codeVerifier;
    return requestTokens(this.source.client, params, invokeCtx?.cancellation.signal);
  }
}

/**
 * Exchange a stored refresh token for a fresh access token, under a claim on the
 * grant key so only one refresh per grant is ever in flight. Shared with
 * `AccessToken`, which refreshes on the same terms.
 */
export async function refreshGrant(
  source: TokenSourceResource,
  key: string,
): Promise<{ tokens: TokenSet | null; reason: string | null }> {
  return source.withRefreshClaim(
    key,
    async () => {
      const existing = await source.readGrant(key);
      if (!existing) return { tokens: null, reason: "no_grant" };
      if (!existing.tokens.refreshToken) return { tokens: null, reason: "no_refresh_token" };

      const refreshed = await requestTokens(source.client, {
        grant_type: "refresh_token",
        refresh_token: existing.tokens.refreshToken,
      });
      // A server that rotates refresh tokens returns a new one; one that does not
      // returns none, and the stored token stays valid — dropping it there would
      // end the grant at the next refresh.
      const merged: TokenSet = {
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? existing.tokens.refreshToken,
        scope: refreshed.scope ?? existing.tokens.scope,
        idToken: refreshed.idToken ?? existing.tokens.idToken,
      };
      await source.writeGrant(key, merged);
      return { tokens: merged, reason: null };
    },
    async () => {
      // Someone else is refreshing this grant. Their write is what this call
      // wanted, so read it rather than issuing a second request with a refresh
      // token they may already have rotated away.
      const current = await source.readGrant(key);
      return current
        ? { tokens: current.tokens, reason: null }
        : { tokens: null, reason: "no_grant" };
    },
  );
}

export class TokenRefreshResource extends SourceOperation {
  async invoke(inputs: { key?: string }) {
    const key = this.source.grantKey(inputs?.key);
    const { tokens, reason } = await refreshGrant(this.source, key);
    if (!tokens) {
      return { refreshed: false, reason, accessToken: null, expiresAt: null, scope: null };
    }
    return {
      refreshed: true,
      reason: null,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    };
  }
}

export class ClientCredentialsResource extends SourceOperation {
  async invoke(inputs: { key?: string; scopes?: string[] }) {
    const key = this.source.grantKey(inputs?.key);
    const params: Record<string, string> = { grant_type: "client_credentials" };
    const scope = scopeParam(inputs?.scopes ?? this.source.client.scopes);
    if (scope) params.scope = scope;

    const tokens = await requestTokens(this.source.client, params);
    await this.source.writeGrant(key, tokens);
    return {
      accessToken: tokens.accessToken,
      tokenType: tokens.tokenType,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
      key,
    };
  }
}

/** A currently-valid access token for `key`, refreshing when it is expired,
 *  inside the skew window, or the caller says the server just rejected it. */
export async function currentAccessToken(
  source: TokenSourceResource,
  key: string,
  forceRefresh: boolean,
): Promise<TokenSet> {
  const existing = await source.readGrant(key);
  if (!existing) {
    throw new RuntimeError(
      "ERR_OAUTH_NO_GRANT",
      `No stored grant for key ${JSON.stringify(key)}. Complete a sign-in for this key first.`,
    );
  }

  const stale = forceRefresh || isExpired(existing.tokens, Date.now(), source.refreshSkewMs);
  if (!stale) return existing.tokens;

  const { tokens, reason } = await refreshGrant(source, key);
  if (tokens) return tokens;
  throw new RuntimeError(
    "ERR_OAUTH_REFRESH_UNAVAILABLE",
    reason === "no_refresh_token"
      ? `The grant for key ${JSON.stringify(key)} has expired and carries no refresh token. ` +
        `The user has to sign in again.`
      : `No stored grant for key ${JSON.stringify(key)}.`,
  );
}

export class AccessTokenResource extends SourceOperation {
  async invoke(inputs: { key?: string; forceRefresh?: boolean }) {
    const tokens = await currentAccessToken(
      this.source,
      this.source.grantKey(inputs?.key),
      inputs?.forceRefresh === true,
    );
    return {
      accessToken: tokens.accessToken,
      tokenType: tokens.tokenType,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    };
  }
}

export const tokenExchange = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: SourceManifest, ctx: ResourceContext) {
    return new TokenExchangeResource(resource, ctx, "TokenExchange");
  },
};

export const tokenRefresh = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: SourceManifest, ctx: ResourceContext) {
    return new TokenRefreshResource(resource, ctx, "TokenRefresh");
  },
};

export const clientCredentials = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: SourceManifest, ctx: ResourceContext) {
    return new ClientCredentialsResource(resource, ctx, "ClientCredentials");
  },
};

export const accessToken = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: SourceManifest, ctx: ResourceContext) {
    return new AccessTokenResource(resource, ctx, "AccessToken");
  },
};

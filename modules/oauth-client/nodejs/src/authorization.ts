import { parseDurationMs, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { challengeFor, createVerifier, randomState } from "./pkce.js";
import { issuerRefusal, requestTokens, scopeParam } from "./token-endpoint.js";
import { resolveSource, type TokenSourceResource } from "./token-source.js";

interface AuthorizationManifest {
  metadata?: { name?: string };
  source: unknown;
  pendingTtl?: string;
}

interface AuthorizationInputs {
  redirectUri: string;
  key?: string;
  scopes?: string[];
  authorizationParams?: Record<string, string>;
}

export class AuthorizationResource implements ResourceInstance {
  readonly source: TokenSourceResource;
  private readonly pendingTtlMs: number;

  constructor(manifest: AuthorizationManifest, ctx: ResourceContext) {
    this.source = resolveSource(
      manifest.source,
      ctx,
      () => `OAuthClient.Authorization "${manifest.metadata?.name ?? ""}"`,
    );
    this.pendingTtlMs = parseDurationMs(manifest.pendingTtl, 600_000);
  }

  async invoke(inputs: AuthorizationInputs) {
    const client = this.source.client;
    const { authorizationEndpoint } = await client.endpoints();
    const key = this.source.grantKey(inputs.key);
    const state = randomState();

    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: inputs.redirectUri,
      state,
    });
    const scope = scopeParam(inputs.scopes ?? client.scopes);
    if (scope) params.set("scope", scope);

    let codeVerifier = "";
    if (client.pkce !== "none") {
      codeVerifier = createVerifier();
      const challenge = challengeFor(client.pkce, codeVerifier);
      params.set("code_challenge", challenge.value);
      params.set("code_challenge_method", challenge.method);
    }

    for (const [name, value] of Object.entries({
      ...client.authorizationParams,
      ...(inputs.authorizationParams ?? {}),
    })) {
      params.set(name, value);
    }

    // Written on every flow, never conditionally: the console flow simply never
    // reads it back (it carries the verifier through `steps.*`) and the TTL
    // expires it. One code path, no branch on how the callback will arrive.
    await this.source.writePending(state, {
      codeVerifier,
      redirectUri: inputs.redirectUri,
      key,
      expiresAt: Date.now() + this.pendingTtlMs,
    });

    const separator = authorizationEndpoint.includes("?") ? "&" : "?";
    return {
      url: `${authorizationEndpoint}${separator}${params.toString()}`,
      state,
      codeVerifier,
      redirectUri: inputs.redirectUri,
      key,
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function isAuthorization(value: unknown): value is AuthorizationResource {
  return value instanceof AuthorizationResource;
}

interface CallbackManifest {
  metadata?: { name?: string };
  authorization: unknown;
}

interface CallbackInputs {
  code?: string | null;
  state?: string | null;
  error?: string | null;
  iss?: string | null;
}

interface CallbackResult {
  ok: boolean;
  reason: string | null;
  key: string | null;
  scope: string | null;
}

function refused(reason: string): CallbackResult {
  return { ok: false, reason, key: null, scope: null };
}

export class CallbackResource implements ResourceInstance {
  private readonly authorization: AuthorizationResource;

  constructor(manifest: CallbackManifest, ctx: ResourceContext) {
    this.authorization = ctx.resolveRef(
      manifest.authorization,
      isAuthorization,
      () => `OAuthClient.Callback "${manifest.metadata?.name ?? ""}": 'authorization'`,
      "OAuthClient.Authorization",
    );
  }

  async invoke(inputs: CallbackInputs): Promise<CallbackResult> {
    // A refusal, an unrecognized state and an expired request are legitimate ends
    // of the flow that a page has to render — returned, not thrown. A token
    // endpoint failure still throws.
    if (inputs.error) return refused(inputs.error === "access_denied" ? "denied" : inputs.error);
    if (!inputs.state || !inputs.code) return refused("unknown_state");

    const source = this.authorization.source;
    const lookup = await source.consumePending(inputs.state);
    if (lookup.state !== "found") {
      return refused(lookup.state === "expired" ? "expired" : "unknown_state");
    }
    const pending = lookup.pending;

    const client = source.client;
    // RFC 9207 — the defence against being handed a code minted by a different
    // server than the one consent was requested from. A server that advertises the
    // parameter and then omits it is refused, not waved through.
    const refusal = issuerRefusal(await client.endpoints(), inputs.iss);
    if (refusal) return refused(refusal);

    const params: Record<string, string> = {
      grant_type: "authorization_code",
      code: inputs.code,
      redirect_uri: pending.redirectUri,
    };
    if (pending.codeVerifier) params.code_verifier = pending.codeVerifier;

    const tokens = await requestTokens(client, params);
    await source.writeGrant(pending.key, tokens);
    return { ok: true, reason: null, key: pending.key, scope: tokens.scope };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const authorization = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: AuthorizationManifest, ctx: ResourceContext) {
    return new AuthorizationResource(resource, ctx);
  },
};

export const callback = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: CallbackManifest, ctx: ResourceContext) {
    return new CallbackResource(resource, ctx);
  },
};

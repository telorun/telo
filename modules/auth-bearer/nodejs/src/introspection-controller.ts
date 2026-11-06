import { isCacheStore } from "@telorun/cache";
import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { toPlainJson } from "@telorun/sdk";
import {
  issuerText,
  readAccessTokenSettings,
  type AccessTokenResource,
} from "./access-token-settings.js";
import {
  completeVerification,
  defaultChallenge,
  resolveAudience,
  type Confirmation,
} from "./access-token-verification.js";
import { sha256Base64Url } from "./dpop-proof.js";
import { durationSetting } from "./duration-setting.js";
import { introspect } from "./introspection-client.js";
import { publishedChallenges, refuse } from "./refusal.js";

interface IntrospectionResource extends AccessTokenResource {
  endpoint: unknown;
  client?: unknown;
  issuer: unknown;
  cache?: unknown;
  maxAge?: unknown;
  timeout?: unknown;
  clockTolerance?: unknown;
}

interface VerifierInputs {
  presentation: { token: string };
  confirmation: Confirmation;
  resource: string | null;
}

const DEFAULT_MAX_AGE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export function register(): void {}

export async function create(
  resource: IntrospectionResource,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  const settings = readAccessTokenSettings(resource, "AuthBearer.Introspection");
  const issuer = issuerText(resource.issuer);
  const endpoint = {
    describe: settings.describe,
    url: toPlainJson(resource.endpoint) as string,
    client: resource.client,
    timeoutMs: durationSetting(resource.timeout, DEFAULT_TIMEOUT_MS, () => `${settings.describe}: 'timeout'`),
  };
  const maxAgeMs = durationSetting(resource.maxAge, DEFAULT_MAX_AGE_MS, () => `${settings.describe}: 'maxAge'`);
  const clockToleranceMs = durationSetting(resource.clockTolerance, 0, () => `${settings.describe}: 'clockTolerance'`);

  return {
    async invoke(inputs: Record<string, any>, invokeCtx?: InvokeContext) {
      const { presentation, confirmation, resource: target } = inputs as VerifierInputs;
      const audience = resolveAudience(ctx, settings, target);
      if (audience.length === 0) return refuse("audience", defaultChallenge(settings));
      const nowMs = Date.now();

      const cache =
        resource.cache === undefined
          ? undefined
          : ctx.resolveRef(resource.cache, isCacheStore, () => `${settings.describe}: 'cache'`, "Cache.Store");
      // The key never holds the token itself, and names the endpoint so a shared cache cannot cross two.
      const cacheKey = `auth-bearer:introspection:${sha256Base64Url(`${endpoint.url}\n${presentation.token}`)}`;

      let claims: Record<string, unknown> | undefined;
      const hit = await cache?.get(cacheKey);
      if (hit?.state === "fresh") claims = hit.value as Record<string, unknown>;
      if (claims === undefined) {
        const answer = await introspect(ctx, endpoint, presentation.token, invokeCtx);
        if (answer.active !== true) return refuse("inactive", defaultChallenge(settings));
        claims = answer;
        if (cache) {
          const untilExpiryMs = typeof answer.exp === "number" ? answer.exp * 1000 - nowMs : Infinity;
          const ttlMs = Math.min(maxAgeMs, untilExpiryMs);
          if (ttlMs > 0) await cache.set(cacheKey, answer, ttlMs, 0);
        }
      }

      // Judged on every request, cached or not: the cache holds the endpoint's answer, not a verdict.
      const dpop = defaultChallenge(settings);
      if (typeof claims.sub !== "string" || claims.sub === "") return refuse("claims", dpop);
      if (claims.iss !== undefined && claims.iss !== issuer) return refuse("issuer", dpop);
      if (claims.exp !== undefined) {
        if (typeof claims.exp !== "number") return refuse("claims", dpop);
        if (claims.exp * 1000 + clockToleranceMs <= nowMs) return refuse("expired", dpop);
      }
      if (claims.nbf !== undefined) {
        if (typeof claims.nbf !== "number") return refuse("claims", dpop);
        if (claims.nbf * 1000 - clockToleranceMs > nowMs) return refuse("notBefore", dpop);
      }
      const tokenAudience = claims.aud;
      const audiences =
        typeof tokenAudience === "string"
          ? [tokenAudience]
          : Array.isArray(tokenAudience) && tokenAudience.every((entry) => typeof entry === "string")
            ? tokenAudience
            : null;
      if (audiences === null || !audiences.some((entry) => audience.includes(entry))) {
        return refuse("audience", dpop);
      }

      return completeVerification(
        ctx,
        settings,
        { token: presentation.token, claims, issuer },
        confirmation,
        nowMs,
      );
    },
    snapshot() {
      return {
        issuer,
        challenges: publishedChallenges(settings.dpop ? { algorithms: settings.dpop.algorithms } : null),
      };
    },
  };
}

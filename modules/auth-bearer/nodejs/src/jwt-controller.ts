import { isJoseKeys, verifyToken } from "@telorun/jose";
import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
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
import { durationSetting } from "./duration-setting.js";
import { publishedChallenges, refuse } from "./refusal.js";

interface JwtResource extends AccessTokenResource {
  keys: unknown;
  issuer: unknown;
  algorithms: string[];
  types?: string[];
  clockTolerance?: unknown;
  maxTokenAge?: unknown;
  requiredClaims?: string[];
}

interface VerifierInputs {
  presentation: { token: string };
  confirmation: Confirmation;
  resource: string | null;
}

const DEFAULT_TYPES = ["at+jwt"];

// RFC 7515 §4.1.9: `typ` compares case-insensitively and may omit `application/`.
function normalizeType(type: unknown): string {
  const text = typeof type === "string" ? type.toLowerCase() : "";
  return text.startsWith("application/") ? text.slice("application/".length) : text;
}

export function register(): void {}

export async function create(resource: JwtResource, ctx: ResourceContext): Promise<ResourceInstance> {
  const settings = readAccessTokenSettings(resource, "AuthBearer.Jwt");
  const issuer = issuerText(resource.issuer);
  const types = (resource.types ?? DEFAULT_TYPES).map(normalizeType);
  const clockToleranceMs = durationSetting(resource.clockTolerance, 0, () => `${settings.describe}: 'clockTolerance'`);
  const maxTokenAgeMs = durationSetting(resource.maxTokenAge, 0, () => `${settings.describe}: 'maxTokenAge'`);
  // An access token without an expiry or subject cannot be judged or attributed;
  // a denylist can only name a token that carries a `jti`.
  const requiredClaims = [
    ...new Set([
      "exp",
      "sub",
      ...(resource.requiredClaims ?? []),
      ...(resource.revocation ? ["jti"] : []),
    ]),
  ];

  return {
    async invoke(inputs: Record<string, any>, invokeCtx?: InvokeContext) {
      const { presentation, confirmation, resource: target } = inputs as VerifierInputs;
      const audience = resolveAudience(ctx, settings, target);
      if (audience.length === 0) return refuse("audience", defaultChallenge(settings));

      const keys = ctx.resolveRef(resource.keys, isJoseKeys, () => `${settings.describe}: 'keys'`, "Jose.Keys");
      const nowMs = Date.now();
      const outcome = await verifyToken(
        keys,
        presentation.token,
        {
          algorithms: resource.algorithms,
          issuer,
          audience,
          clockToleranceSeconds: clockToleranceMs / 1000,
          maxTokenAgeSeconds: maxTokenAgeMs > 0 ? maxTokenAgeMs / 1000 : undefined,
          requiredClaims,
        },
        invokeCtx?.cancellation.signal,
      );
      if (!outcome.valid) return refuse(outcome.reason, defaultChallenge(settings));
      if (!types.includes(normalizeType(outcome.header.typ))) return refuse("type", defaultChallenge(settings));

      return completeVerification(
        ctx,
        settings,
        { token: presentation.token, claims: outcome.payload as Record<string, unknown>, issuer },
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

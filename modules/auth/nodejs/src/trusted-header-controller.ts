import type { ResourceContext, ResourceInstance, ResourceManifest } from "@telorun/sdk";

interface TrustedHeaderResource extends ResourceManifest {
  principalIssuer?: string;
  principalKind?: "user" | "service";
  claimNames?: { roles?: string; scopes?: string; permissions?: string; org?: string };
}

interface AssertedInputs {
  presentation: { subject: string; claims: Record<string, unknown> };
}

class ClaimMalformed extends Error {}

/** A claim holding a list: an array of strings, or one whitespace-separated string. */
function listClaim(claims: Record<string, unknown>, name: string): string[] {
  const value = claims[name];
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.split(/\s+/).filter((entry) => entry !== "");
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  throw new ClaimMalformed(`claim '${name}' is neither a list of strings nor a string`);
}

function textClaim(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new ClaimMalformed(`claim '${name}' is not a string`);
}

export function register(): void {}

export async function create(
  resource: TrustedHeaderResource,
  _ctx: ResourceContext,
): Promise<ResourceInstance> {
  const via = String(resource.metadata.name);
  const names = {
    roles: resource.claimNames?.roles ?? "roles",
    scopes: resource.claimNames?.scopes ?? "scopes",
    permissions: resource.claimNames?.permissions ?? "permissions",
    org: resource.claimNames?.org ?? "org",
  };
  const refuse = (reason: string) => ({ refused: true as const, reason, challenge: null });

  return {
    async invoke(inputs: Record<string, any>) {
      const { subject, claims } = (inputs as AssertedInputs).presentation;
      if (subject === "") return refuse("the asserted subject is empty");
      try {
        return {
          principal: {
            subject,
            issuer: resource.principalIssuer ?? null,
            kind: resource.principalKind ?? "user",
            claims,
            scopes: listClaim(claims, names.scopes),
            roles: listClaim(claims, names.roles),
            permissions: listClaim(claims, names.permissions),
            org: textClaim(claims, names.org),
            amr: [],
            acr: null,
            sessionId: null,
            authenticatedAt: null,
            via,
          },
        };
      } catch (error) {
        if (error instanceof ClaimMalformed) return refuse(`the asserted ${error.message}`);
        throw error;
      }
    },
    snapshot() {
      return {
        principalIssuer: resource.principalIssuer,
        principalKind: resource.principalKind,
        claimNames: resource.claimNames,
        challenges: [],
      };
    },
  };
}

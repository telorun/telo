import {
  celTimestampFromMillis,
  isCelTimestamp,
  RuntimeError,
  type ResourceContext,
} from "@telorun/sdk";
import { listClaim } from "./claim-readers.js";
import type { AccessTokenSettings } from "./access-token-settings.js";

/** A claim the token carries in a shape the principal cannot be built from. */
export class ClaimsUnreadable extends Error {}

const KINDS = ["user", "service"];

function stringList(value: unknown, member: string, describe: string): string[] {
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  throw new RuntimeError(
    "ERR_AUTH_BEARER_PRINCIPAL_INVALID",
    `${describe}: 'principal.${member}' must evaluate to a list of strings.`,
  );
}

function claimList(claims: Record<string, unknown>, name: string): string[] {
  const list = listClaim(claims, name);
  if (list === null) throw new ClaimsUnreadable(`claim '${name}' is neither a list of strings nor a string`);
  return list;
}

function claimText(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new ClaimsUnreadable(`claim '${name}' is not a string`);
}

/**
 * Builds the `Auth.Principal` for verified claims. A configured mapping is
 * evaluated over `claims`; otherwise the member is read from the standard
 * claim. Throws `ClaimsUnreadable` when a standard claim has the wrong shape.
 */
export function buildPrincipal(
  ctx: ResourceContext,
  settings: AccessTokenSettings,
  claims: Record<string, unknown>,
  issuer: string,
) {
  const mapping = settings.principal;
  const bindings = { claims };
  const mapped = (field: unknown) => ctx.expandValue(field, bindings);

  let kind: string;
  if (mapping.kind !== undefined) {
    kind = mapped(mapping.kind);
    if (!KINDS.includes(kind)) {
      throw new RuntimeError(
        "ERR_AUTH_BEARER_PRINCIPAL_INVALID",
        `${settings.describe}: 'principal.kind' must evaluate to 'user' or 'service'.`,
      );
    }
  } else {
    kind = claims.sub !== undefined && claims.sub === claims.client_id ? "service" : "user";
  }

  const scopes =
    mapping.scopes !== undefined
      ? stringList(mapped(mapping.scopes), "scopes", settings.describe)
      : claims.scope !== undefined
        ? claimList(claims, "scope")
        : claimList(claims, "scp");
  const roles =
    mapping.roles !== undefined
      ? stringList(mapped(mapping.roles), "roles", settings.describe)
      : claimList(claims, "roles");
  const permissions =
    mapping.permissions !== undefined
      ? stringList(mapped(mapping.permissions), "permissions", settings.describe)
      : claimList(claims, "permissions");

  let org: string | null = null;
  if (mapping.org !== undefined) {
    const value = mapped(mapping.org);
    if (value !== null && typeof value !== "string") {
      throw new RuntimeError(
        "ERR_AUTH_BEARER_PRINCIPAL_INVALID",
        `${settings.describe}: 'principal.org' must evaluate to a string or null.`,
      );
    }
    org = value;
  }

  let authenticatedAt = null;
  if (claims.auth_time !== undefined) {
    if (typeof claims.auth_time !== "number") throw new ClaimsUnreadable("claim 'auth_time' is not a number");
    authenticatedAt = celTimestampFromMillis(claims.auth_time * 1000);
    if (!isCelTimestamp(authenticatedAt)) throw new ClaimsUnreadable("claim 'auth_time' is out of range");
  }

  return {
    subject: claims.sub as string,
    issuer,
    kind,
    claims,
    scopes,
    roles,
    permissions,
    org,
    amr: claimList(claims, "amr"),
    acr: claimText(claims, "acr"),
    sessionId: null,
    authenticatedAt,
    via: settings.via,
  };
}

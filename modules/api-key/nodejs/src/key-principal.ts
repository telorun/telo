import type { StoredKey } from "./store-contract.js";
import { publicIdOf } from "./key-format.js";

/** The `Auth.Principal` of a key that passed every check. */
export function principalOf(key: StoredKey, via: string) {
  const organization = key.owner.type === "organization";
  return {
    subject: key.owner.id,
    issuer: null,
    kind: key.owner.type === "user" ? "user" : "service",
    claims: { apiKeyId: publicIdOf(key.id) },
    scopes: [...key.scopes],
    roles: [] as string[],
    permissions: [] as string[],
    org: organization ? key.owner.id : null,
    amr: [] as string[],
    acr: null,
    sessionId: null,
    authenticatedAt: null,
    via,
  };
}

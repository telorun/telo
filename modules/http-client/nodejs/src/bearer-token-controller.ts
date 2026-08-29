import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { requireCredentialMaterial, type CredentialOutputs } from "./credential-material.js";

interface BearerTokenManifest {
  metadata: { name: string; module?: string };
  token?: string;
  scheme?: string;
}

/**
 * `Authorization: Bearer <token>` — most APIs, and the shape an OAuth access
 * token takes once it has been acquired.
 *
 * `forceRefresh` is honoured by returning the same material, which is not a
 * stub: re-acquiring a value the author wrote down genuinely yields what it
 * already had. The retry then fails a second time and propagates, which is the
 * right report — the token is wrong, not stale.
 */
class BearerToken implements ResourceInstance<unknown, CredentialOutputs> {
  constructor(private readonly resource: BearerTokenManifest) {}

  async invoke(): Promise<CredentialOutputs> {
    const token = requireCredentialMaterial(
      this.resource.token,
      "Http.BearerToken",
      this.resource.metadata.name,
      "token",
    );
    return { headers: { authorization: `${this.resource.scheme ?? "Bearer"} ${token}` } };
  }

  /** The token is deliberately absent. A snapshot is a READING — published into
   *  CEL and onto the debug stream — and the token has no use there. */
  snapshot(): Record<string, unknown> {
    return { scheme: this.resource.scheme ?? "Bearer" };
  }
}

export function register(): void {}

export async function create(
  resource: BearerTokenManifest,
  _ctx: ResourceContext,
): Promise<BearerToken> {
  return new BearerToken(resource);
}

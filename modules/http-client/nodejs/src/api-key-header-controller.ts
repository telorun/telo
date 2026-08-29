import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { requireCredentialMaterial, type CredentialOutputs } from "./credential-material.js";

interface ApiKeyHeaderManifest {
  metadata: { name: string; module?: string };
  header?: string;
  key?: string;
  prefix?: string;
}

/**
 * A key in a header of the service's choosing — Anthropic's `x-api-key`, and
 * most gateways.
 *
 * The header name is lower-cased on the way out, because that is how the
 * request controller keys its own header map; leaving the author's casing would
 * let a per-request `X-Api-Key` sit beside this one rather than override it.
 */
class ApiKeyHeader implements ResourceInstance<unknown, CredentialOutputs> {
  constructor(private readonly resource: ApiKeyHeaderManifest) {}

  async invoke(): Promise<CredentialOutputs> {
    const name = this.resource.metadata.name;
    const header = requireCredentialMaterial(
      this.resource.header,
      "Http.ApiKeyHeader",
      name,
      "header",
    );
    const key = requireCredentialMaterial(this.resource.key, "Http.ApiKeyHeader", name, "key");
    const value = this.resource.prefix === undefined ? key : `${this.resource.prefix}${key}`;
    return { headers: { [header.toLowerCase()]: value } };
  }

  /** The header NAME is configuration and readable; the key is not. */
  snapshot(): Record<string, unknown> {
    return { header: this.resource.header ?? "" };
  }
}

export function register(): void {}

export async function create(
  resource: ApiKeyHeaderManifest,
  _ctx: ResourceContext,
): Promise<ApiKeyHeader> {
  return new ApiKeyHeader(resource);
}

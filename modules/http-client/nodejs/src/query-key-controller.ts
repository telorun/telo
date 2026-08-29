import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { requireCredentialMaterial, type CredentialOutputs } from "./credential-material.js";

interface QueryKeyManifest {
  metadata: { name: string; module?: string };
  parameter?: string;
  key?: string;
}

/**
 * A key in the query string — Google AI Studio's `?key=`, and the older
 * generation of REST APIs.
 *
 * A key carried in a URL reaches access logs, proxies and browser history, so a
 * service offering both spellings is better served by `Http.ApiKeyHeader`. This
 * exists for the ones that offer only this.
 */
class QueryKey implements ResourceInstance<unknown, CredentialOutputs> {
  constructor(private readonly resource: QueryKeyManifest) {}

  async invoke(): Promise<CredentialOutputs> {
    const name = this.resource.metadata.name;
    const parameter = requireCredentialMaterial(
      this.resource.parameter,
      "Http.QueryKey",
      name,
      "parameter",
    );
    const key = requireCredentialMaterial(this.resource.key, "Http.QueryKey", name, "key");
    return { query: { [parameter]: key } };
  }

  /** The parameter NAME is configuration and readable; the key is not. */
  snapshot(): Record<string, unknown> {
    return { parameter: this.resource.parameter ?? "" };
  }
}

export function register(): void {}

export async function create(
  resource: QueryKeyManifest,
  _ctx: ResourceContext,
): Promise<QueryKey> {
  return new QueryKey(resource);
}

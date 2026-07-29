import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { currentAccessToken } from "./tokens.js";
import { resolveSource, type TokenSourceResource } from "./token-source.js";

interface CredentialManifest {
  metadata?: { name?: string };
  source: unknown;
  key?: string;
  headerName?: string;
  scheme?: string;
}

interface CredentialInputs {
  request: { method: string; url: string; headers?: Record<string, string> };
  forceRefresh?: boolean;
}

/**
 * `Http.Credential` over a token source. The request goes in and headers come
 * out, so this satisfies the same abstract an API key or a request-signing
 * scheme does — it simply ignores everything but `forceRefresh`.
 *
 * `forceRefresh` is what the http-client request controller sets on its single
 * retry after a 401. Here it means: do not trust the stored expiry, get a new
 * token. The refresh itself is claimed on the grant key, so a burst of rejected
 * requests produces one refresh rather than one each.
 */
export class CredentialResource implements ResourceInstance {
  private readonly source: TokenSourceResource;
  private readonly headerName: string;
  private readonly scheme: string;

  constructor(private readonly manifest: CredentialManifest, ctx: ResourceContext) {
    this.source = resolveSource(
      manifest.source,
      ctx,
      () => `OAuthClient.Credential "${manifest.metadata?.name ?? ""}"`,
    );
    this.headerName = manifest.headerName ?? "Authorization";
    this.scheme = manifest.scheme ?? "Bearer";
  }

  async invoke(inputs: CredentialInputs) {
    const tokens = await currentAccessToken(
      this.source,
      this.source.grantKey(this.manifest.key),
      inputs?.forceRefresh === true,
    );
    const value = this.scheme ? `${this.scheme} ${tokens.accessToken}` : tokens.accessToken;
    return { headers: { [this.headerName]: value } };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const credential = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: CredentialManifest, ctx: ResourceContext) {
    return new CredentialResource(resource, ctx);
  },
};

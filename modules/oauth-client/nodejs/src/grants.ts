import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { resolveSource, type TokenSourceResource } from "./token-source.js";
import type { TokenSet } from "./token-set.js";

interface GrantManifest {
  metadata?: { name?: string };
  source: unknown;
}

/** The three grant operations differ only in what they do with the key, so they
 *  share how they find their source. */
abstract class GrantOperation implements ResourceInstance {
  protected readonly source: TokenSourceResource;

  constructor(manifest: GrantManifest, ctx: ResourceContext, kind: string) {
    this.source = resolveSource(
      manifest.source,
      ctx,
      () => `OAuthClient.${kind} "${manifest.metadata?.name ?? ""}"`,
    );
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export class GrantReadResource extends GrantOperation {
  async invoke(inputs: { key?: string }) {
    const grant = await this.source.readGrant(this.source.grantKey(inputs?.key));
    if (!grant) {
      return { exists: false, scope: null, expiresAt: null, hasRefreshToken: false };
    }
    return {
      exists: true,
      scope: grant.tokens.scope,
      expiresAt: grant.tokens.expiresAt,
      hasRefreshToken: grant.tokens.refreshToken !== null,
    };
  }
}

export class GrantWriteResource extends GrantOperation {
  async invoke(inputs: { key?: string; tokens: TokenSet }) {
    const key = this.source.grantKey(inputs.key);
    await this.source.writeGrant(key, {
      accessToken: inputs.tokens.accessToken,
      tokenType: inputs.tokens.tokenType ?? "Bearer",
      expiresAt: inputs.tokens.expiresAt ?? null,
      refreshToken: inputs.tokens.refreshToken ?? null,
      scope: inputs.tokens.scope ?? null,
      idToken: inputs.tokens.idToken ?? null,
    });
    return { key };
  }
}

export class GrantClearResource extends GrantOperation {
  async invoke(inputs: { key?: string }) {
    return { cleared: await this.source.clearGrant(this.source.grantKey(inputs?.key)) };
  }
}

export const grantRead = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: GrantManifest, ctx: ResourceContext) {
    return new GrantReadResource(resource, ctx, "GrantRead");
  },
};

export const grantWrite = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: GrantManifest, ctx: ResourceContext) {
    return new GrantWriteResource(resource, ctx, "GrantWrite");
  },
};

export const grantClear = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: GrantManifest, ctx: ResourceContext) {
    return new GrantClearResource(resource, ctx, "GrantClear");
  },
};

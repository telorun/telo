import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  isAuthorizationServer,
  type AuthorizationServerResource,
  type ServerEndpoints,
} from "./authorization-server.js";

export type PkceMode = "S256" | "plain" | "none";
export type AuthMethod = "client_secret_basic" | "client_secret_post" | "none";

interface ClientManifest {
  metadata?: { name?: string };
  authorizationServer: unknown;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  pkce?: PkceMode;
  tokenEndpointAuthMethod?: AuthMethod;
  authorizationParams?: Record<string, string>;
}

export class ClientResource implements ResourceInstance {
  private readonly server: AuthorizationServerResource;

  constructor(
    private readonly manifest: ClientManifest,
    ctx: ResourceContext,
  ) {
    this.server = ctx.resolveRef(
      manifest.authorizationServer,
      isAuthorizationServer,
      () => `OAuthClient.Client "${manifest.metadata?.name ?? ""}": 'authorizationServer'`,
      "OAuthClient.AuthorizationServer",
    );
  }

  get clientId(): string {
    return this.manifest.clientId;
  }

  get clientSecret(): string | null {
    return this.manifest.clientSecret ?? null;
  }

  get scopes(): string[] {
    return this.manifest.scopes ?? [];
  }

  get pkce(): PkceMode {
    return this.manifest.pkce ?? "S256";
  }

  get authMethod(): AuthMethod {
    return this.manifest.tokenEndpointAuthMethod ?? "client_secret_basic";
  }

  get authorizationParams(): Record<string, string> {
    return this.manifest.authorizationParams ?? {};
  }

  /** Resolved endpoints for this client's server, discovering them on first use. */
  endpoints(): Promise<ServerEndpoints> {
    return this.server.provide();
  }

  async provide(): Promise<ClientResource> {
    return this;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function isClient(value: unknown): value is ClientResource {
  return value instanceof ClientResource;
}

export const client = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: ClientManifest, ctx: ResourceContext) {
    return new ClientResource(resource, ctx);
  },
};

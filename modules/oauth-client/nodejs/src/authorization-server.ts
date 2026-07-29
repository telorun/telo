import {
  parseDurationMs,
  RuntimeError,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";

/** The endpoints an operation needs, however they were obtained. */
export interface ServerEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint: string | null;
  /** RFC 9207: the server states it returns `iss` on the authorization response.
   *  When it does, a response arriving WITHOUT one is refused rather than let
   *  through — a missing `iss` is exactly what a mix-up attack produces. Only a
   *  discovery document can tell us; an explicitly configured server cannot. */
  issuerParameterSupported: boolean;
  /** Per-request deadline for every call to this server. */
  timeoutMs: number;
}

interface AuthorizationServerManifest {
  metadata?: { name?: string };
  issuer: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  timeout?: string;
}

/** OIDC Discovery appends to the issuer; RFC 8414 inserts before its path. Both
 *  are tried because providers are split between them, and a tenant-scoped issuer
 *  resolves to different URLs under each. */
function discoveryUrls(issuer: string): string[] {
  const trimmed = issuer.replace(/\/+$/, "");
  const urls = [`${trimmed}/.well-known/openid-configuration`];
  const parsed = new URL(trimmed);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  urls.push(`${parsed.origin}/.well-known/oauth-authorization-server${path}`);
  return urls;
}

export class AuthorizationServerResource implements ResourceInstance {
  /** Memoized as the in-flight promise, so concurrent first callers share one
   *  fetch rather than each issuing an identical request. */
  private resolution?: Promise<ServerEndpoints>;

  constructor(
    private readonly manifest: AuthorizationServerManifest,
    private readonly ctx: ResourceContext,
  ) {}

  private describe(): string {
    return `OAuthClient.AuthorizationServer "${this.manifest.metadata?.name ?? ""}"`;
  }

  /** Endpoints given explicitly win, and a complete set suppresses discovery
   *  entirely — a pinned or air-gapped deployment never reaches the network. */
  get timeoutMs(): number {
    return parseDurationMs(this.manifest.timeout, 30_000);
  }

  private declared(): ServerEndpoints | null {
    const { issuer, authorizationEndpoint, tokenEndpoint, deviceAuthorizationEndpoint } =
      this.manifest;
    if (!authorizationEndpoint || !tokenEndpoint) return null;
    return {
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      deviceAuthorizationEndpoint: deviceAuthorizationEndpoint ?? null,
      // Nothing was discovered, so nothing states the parameter is sent. `iss` is
      // still verified when one arrives; it just cannot be made mandatory here.
      issuerParameterSupported: false,
      timeoutMs: this.timeoutMs,
    };
  }

  private async discover(): Promise<ServerEndpoints> {
    const timeoutMs = this.timeoutMs;
    const attempted: string[] = [];
    for (const url of discoveryUrls(this.manifest.issuer)) {
      attempted.push(url);
      const document = await this.fetchMetadata(url, timeoutMs);
      if (!document) continue;

      const issuer = document.issuer;
      if (typeof issuer === "string" && issuer !== this.manifest.issuer) {
        throw new RuntimeError(
          "ERR_OAUTH_ISSUER_MISMATCH",
          `${this.describe()}: metadata at ${url} declares issuer ${JSON.stringify(issuer)}, ` +
            `but this resource declares ${JSON.stringify(this.manifest.issuer)}. ` +
            `Set 'issuer' to the value the server publishes.`,
        );
      }

      const authorizationEndpoint =
        this.manifest.authorizationEndpoint ?? asString(document.authorization_endpoint);
      const tokenEndpoint = this.manifest.tokenEndpoint ?? asString(document.token_endpoint);
      if (!authorizationEndpoint || !tokenEndpoint) continue;

      return {
        issuer: this.manifest.issuer,
        authorizationEndpoint,
        tokenEndpoint,
        deviceAuthorizationEndpoint:
          this.manifest.deviceAuthorizationEndpoint ??
          asString(document.device_authorization_endpoint),
        issuerParameterSupported: document.authorization_response_iss_parameter_supported === true,
        timeoutMs,
      };
    }

    throw new RuntimeError(
      "ERR_OAUTH_DISCOVERY_FAILED",
      `${this.describe()}: no usable metadata for issuer ${JSON.stringify(this.manifest.issuer)}. ` +
        `Tried ${attempted.join(" and ")}. ` +
        `Set 'authorizationEndpoint' and 'tokenEndpoint' explicitly if this server publishes no metadata document.`,
    );
  }

  private async fetchMetadata(
    url: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return (await response.json()) as Record<string, unknown>;
    } catch (err) {
      // A document that is absent at this URL is not a failure — the other form
      // may still serve it. Only exhausting every form is, and `discover` raises
      // that with the URLs it tried.
      this.ctx.log.debug(`${this.describe()}: discovery at ${url} failed`, {
        url,
        error: (err as Error).message,
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolved endpoints. Discovery happens here, on first use — never in
   *  `init()`, so an application that never authenticates never fetches and an
   *  unreachable server cannot stop one from starting. */
  async provide(): Promise<ServerEndpoints> {
    const declared = this.declared();
    if (declared) return declared;
    this.resolution ??= this.discover().catch((err) => {
      // Do not memoize a failure: the server may simply have been down, and the
      // next call deserves a fresh attempt rather than a cached error forever.
      this.resolution = undefined;
      throw err;
    });
    return this.resolution;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isAuthorizationServer(value: unknown): value is AuthorizationServerResource {
  return value instanceof AuthorizationServerResource;
}

export const authorizationServer = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: AuthorizationServerManifest, ctx: ResourceContext) {
    return new AuthorizationServerResource(resource, ctx);
  },
};

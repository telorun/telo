import { createHash } from "node:crypto";

import { resolveDockerCredential } from "./docker-credentials.js";

export const TELO_LAYER_MEDIA_TYPE = "application/vnd.telo.module.v1+tar";
export const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
export const OCI_EMPTY_CONFIG_MEDIA_TYPE = "application/vnd.oci.empty.v1+json";

/** The standard OCI empty descriptor — config `{}` (2 bytes). */
const EMPTY_CONFIG = Buffer.from("{}", "utf-8");
const EMPTY_CONFIG_DIGEST = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

const MANIFEST_ACCEPT = [
  OCI_MANIFEST_MEDIA_TYPE,
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

export interface OciDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  data?: string;
  artifactType?: string;
}

export interface OciManifest {
  schemaVersion: number;
  mediaType?: string;
  artifactType?: string;
  config: OciDescriptor;
  layers: OciDescriptor[];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Parse a `WWW-Authenticate: Bearer realm="...",service="...",scope="..."` header. */
function parseBearerChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const params = header.replace(/^Bearer\s+/i, "");
  for (const m of params.matchAll(/([a-z]+)="([^"]*)"/gi)) {
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/**
 * A minimal OCI distribution (registry v2) client — exactly the surface Telo
 * needs: pull manifest / pull blob / push blob / push manifest / list tags,
 * with the `WWW-Authenticate` bearer-token handshake and the ambient Docker
 * credential chain. Hand-rolled rather than depending on a stale/Deno-only
 * client (see plan Decisions). One instance per `(host, repo)`; tokens are
 * cached per scope for the instance's lifetime.
 */
export class OciClient {
  private readonly tokenByScope = new Map<string, string>();

  constructor(
    private readonly host: string,
    private readonly repo: string,
  ) {}

  private base(): string {
    return `https://${this.host}/v2/${this.repo}`;
  }

  private pullScope(): string {
    return `repository:${this.repo}:pull`;
  }

  private pushScope(): string {
    return `repository:${this.repo}:pull,push`;
  }

  /** Fetch with the bearer-token dance: try (cached token if any), and on 401
   *  resolve a token from the `WWW-Authenticate` challenge and retry once. */
  private async authedFetch(
    url: string,
    init: RequestInit,
    scope: string,
  ): Promise<Response> {
    const withToken = (token?: string): RequestInit => {
      const headers = new Headers(init.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      return { ...init, headers };
    };

    const cached = this.tokenByScope.get(scope);
    let res = await fetch(url, withToken(cached));
    if (res.status !== 401) return res;

    const challenge = res.headers.get("www-authenticate");
    if (!challenge) return res;
    const token = await this.fetchToken(challenge, scope);
    if (!token) return res;
    this.tokenByScope.set(scope, token);
    // Drain the 401 body so the connection can be reused.
    await res.text().catch(() => {});
    return fetch(url, withToken(token));
  }

  /** Exchange a bearer challenge for a token, authenticating to the token
   *  service with Docker credentials when available (else anonymous). */
  private async fetchToken(challenge: string, scope: string): Promise<string | null> {
    const params = parseBearerChallenge(challenge);
    if (!params.realm) return null;
    const tokenUrl = new URL(params.realm);
    if (params.service) tokenUrl.searchParams.set("service", params.service);
    tokenUrl.searchParams.set("scope", params.scope || scope);

    const headers = new Headers();
    const cred = await resolveDockerCredential(this.host);
    if (cred) {
      const basic = Buffer.from(`${cred.username}:${cred.password}`).toString("base64");
      headers.set("authorization", `Basic ${basic}`);
    }
    const res = await fetch(tokenUrl.href, { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string; access_token?: string };
    return body.token ?? body.access_token ?? null;
  }

  async pullManifest(reference: string): Promise<OciManifest> {
    const res = await this.authedFetch(
      `${this.base()}/manifests/${reference}`,
      { headers: { accept: MANIFEST_ACCEPT } },
      this.pullScope(),
    );
    if (!res.ok) {
      throw new Error(
        `OCI pull manifest ${this.repo}:${reference} on ${this.host} failed: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as OciManifest;
  }

  async pullBlob(digest: string): Promise<Buffer> {
    const res = await this.authedFetch(`${this.base()}/blobs/${digest}`, {}, this.pullScope());
    if (!res.ok) {
      throw new Error(
        `OCI pull blob ${digest} from ${this.repo} on ${this.host} failed: ${res.status} ${res.statusText}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async listTags(): Promise<string[]> {
    const res = await this.authedFetch(`${this.base()}/tags/list`, {}, this.pullScope());
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(
        `OCI list tags for ${this.repo} on ${this.host} failed: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { tags?: string[] | null };
    return Array.isArray(body.tags) ? body.tags : [];
  }

  /** Upload `bytes` as a blob (skipped when already present), returning its
   *  `sha256:<hex>` digest. Two-step upload: obtain a session, then PUT with
   *  the digest. */
  async pushBlob(bytes: Uint8Array): Promise<string> {
    const digest = `sha256:${sha256Hex(bytes)}`;

    const head = await this.authedFetch(
      `${this.base()}/blobs/${digest}`,
      { method: "HEAD" },
      this.pushScope(),
    );
    if (head.ok) return digest; // already present
    await head.text().catch(() => {});

    const start = await this.authedFetch(
      `${this.base()}/blobs/uploads/`,
      { method: "POST" },
      this.pushScope(),
    );
    if (start.status !== 202) {
      throw new Error(
        `OCI blob upload start for ${this.repo} on ${this.host} failed: ${start.status} ${start.statusText}`,
      );
    }
    const location = start.headers.get("location");
    await start.text().catch(() => {});
    if (!location) {
      throw new Error(`OCI blob upload for ${this.repo} returned no Location header`);
    }
    const uploadUrl = new URL(location, `https://${this.host}`);
    uploadUrl.searchParams.set("digest", digest);

    const put = await this.authedFetch(
      uploadUrl.href,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      },
      this.pushScope(),
    );
    if (put.status !== 201) {
      const detail = await put.text().catch(() => "");
      throw new Error(
        `OCI blob PUT for ${this.repo} on ${this.host} failed: ${put.status} ${put.statusText} ${detail}`,
      );
    }
    return digest;
  }

  async pushManifest(reference: string, manifest: OciManifest): Promise<void> {
    const body = Buffer.from(JSON.stringify(manifest), "utf-8");
    const res = await this.authedFetch(
      `${this.base()}/manifests/${reference}`,
      { method: "PUT", headers: { "content-type": OCI_MANIFEST_MEDIA_TYPE }, body },
      this.pushScope(),
    );
    if (res.status !== 201) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `OCI push manifest ${this.repo}:${reference} on ${this.host} failed: ${res.status} ${res.statusText} ${detail}`,
      );
    }
  }

  /** Push the standard empty config blob and return its descriptor. */
  async pushEmptyConfig(): Promise<OciDescriptor> {
    await this.pushBlob(EMPTY_CONFIG);
    return {
      mediaType: OCI_EMPTY_CONFIG_MEDIA_TYPE,
      digest: EMPTY_CONFIG_DIGEST,
      size: EMPTY_CONFIG.length,
      data: EMPTY_CONFIG.toString("base64"),
    };
  }
}

import { fetchOrThrow } from "@telorun/sdk";
import { createHash } from "node:crypto";

import { assertPublicEgress } from "../egress-guard.js";
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
  /** Descriptive key/value metadata on the manifest. Telo projects the module's
   *  declared provenance into the standard `org.opencontainers.image.*` keys —
   *  the only metadata channel GHCR exposes, since it does not serve the
   *  referrers API. */
  annotations?: Record<string, string>;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Resolve the `rel="next"` target of a `Link` header against the registry
 *  origin, or `null` when there is no next page. */
function nextPageUrl(linkHeader: string | null, origin: string): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;[^,]*rel="?next"?/i);
    if (m) return new URL(m[1], origin).href;
  }
  return null;
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
    // Registry refs are attacker-suppliable once public registration exists —
    // refuse non-public hosts under TELO_EGRESS=public-only (no-op otherwise).
    await assertPublicEgress(url);
    const withToken = (token?: string): RequestInit => {
      const headers = new Headers(init.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      return { ...init, headers };
    };

    const cached = this.tokenByScope.get(scope);
    let res = await fetchOrThrow(url, withToken(cached), {
      operation: "OCI registry request",
      setting: "the oci:// ref host",
    });
    if (res.status !== 401) return res;

    const challenge = res.headers.get("www-authenticate");
    if (!challenge) return res;
    const token = await this.fetchToken(challenge, scope);
    if (!token) return res;
    this.tokenByScope.set(scope, token);
    // Drain the 401 body so the connection can be reused.
    await res.text().catch(() => {});
    return fetchOrThrow(url, withToken(token), {
      operation: "OCI registry request",
      setting: "the oci:// ref host",
    });
  }

  /** Exchange a bearer challenge for a token, authenticating to the token
   *  service with Docker credentials when available (else anonymous). */
  private async fetchToken(challenge: string, scope: string): Promise<string | null> {
    const params = parseBearerChallenge(challenge);
    if (!params.realm) return null;
    // The token realm comes from the registry's own WWW-Authenticate header —
    // an attacker-controlled registry could point it anywhere, so it is
    // egress-checked like any other host.
    await assertPublicEgress(params.realm);
    const tokenUrl = new URL(params.realm);
    if (params.service) tokenUrl.searchParams.set("service", params.service);
    tokenUrl.searchParams.set("scope", params.scope || scope);

    const headers = new Headers();
    const cred = await resolveDockerCredential(this.host);
    if (cred) {
      const basic = Buffer.from(`${cred.username}:${cred.password}`).toString("base64");
      headers.set("authorization", `Basic ${basic}`);
    }
    const res = await fetchOrThrow(tokenUrl.href, { headers }, {
      operation: "OCI registry auth",
      setting: "the oci:// ref host",
    });
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

  /** Content-identity digest of the manifest a reference resolves to, via a
   *  HEAD request — no blob download. Falls back to hashing the manifest body
   *  when the registry omits `Docker-Content-Digest`. `null` when the
   *  reference does not exist. */
  async headManifest(reference: string): Promise<string | null> {
    const url = `${this.base()}/manifests/${reference}`;
    const head = await this.authedFetch(
      url,
      { method: "HEAD", headers: { accept: MANIFEST_ACCEPT } },
      this.pullScope(),
    );
    await head.text().catch(() => {});
    if (head.status === 404) return null;
    if (!head.ok) {
      throw new Error(
        `OCI head manifest ${this.repo}:${reference} on ${this.host} failed: ${head.status} ${head.statusText}`,
      );
    }
    const digest = head.headers.get("docker-content-digest");
    if (digest) return digest;

    const res = await this.authedFetch(url, { headers: { accept: MANIFEST_ACCEPT } }, this.pullScope());
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(
        `OCI pull manifest ${this.repo}:${reference} on ${this.host} failed: ${res.status} ${res.statusText}`,
      );
    }
    return `sha256:${sha256Hex(new Uint8Array(await res.arrayBuffer()))}`;
  }

  /** All tags, following the distribution spec's pagination (`Link: …;
   *  rel="next"` with `last=` cursors) so a many-versioned repo enumerates
   *  fully — registries cap a single page (Docker Hub at 100). */
  async listTags(): Promise<string[]> {
    const tags: string[] = [];
    let url: string | null = `${this.base()}/tags/list?n=1000`;
    const seen = new Set<string>();
    while (url && !seen.has(url)) {
      seen.add(url);
      const res: Response = await this.authedFetch(url, {}, this.pullScope());
      if (res.status === 404) return tags;
      if (!res.ok) {
        throw new Error(
          `OCI list tags for ${this.repo} on ${this.host} failed: ${res.status} ${res.statusText}`,
        );
      }
      const body = (await res.json()) as { tags?: string[] | null };
      if (Array.isArray(body.tags)) tags.push(...body.tags);
      url = nextPageUrl(res.headers.get("link"), `https://${this.host}`);
    }
    return tags;
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

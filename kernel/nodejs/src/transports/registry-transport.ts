import {
  DEFAULT_MANIFEST_FILENAME,
  HttpSource,
  IntegrityError,
  RegistrySource,
  isRegistryRef,
  parseModuleRef,
  sha256Base64Url,
  splitIntegrity,
  type ManifestSource,
} from "@telorun/analyzer";
import { fetchOrThrow } from "@telorun/sdk";
import { createHash } from "crypto";

import { computeFilesIntegrity, injectFilesIntegrity } from "../bundle/files-integrity.js";
import { readOwnerManifest } from "../bundle/module-manifest.js";
import { makeTarGz, readTarGz, toPayloadFiles } from "../bundle/tar.js";
import { assertPublicEgress } from "./egress-guard.js";
import type {
  FetchedArtifact,
  PublishBundle,
  PublishOptions,
  PublishResult,
  SiblingIdentity,
  Transport,
} from "./transport.js";

const DEFAULT_REGISTRY_URL = "https://registry.telo.run";
const HTTP_NAMESPACE = "__http";
const QUERY_HASH_LENGTH = 12;
const MAX_PUSH_ATTEMPTS = 4;
const PUSH_BASE_DELAY_MS = 1000;

/** Registry / object-storage backends treat 408/425/429/5xx as transient. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirror `HttpSource.read`'s `fetchUrl` derivation: when the URL does not
 *  already point at a YAML file, append `/telo.yaml`, so a raw import URL and
 *  the canonical source it resolves to map to the same cache path. */
function normalizePathname(rawUrl: string, parsed: URL): string {
  let pathname = parsed.pathname;
  if (!rawUrl.includes(".yaml")) {
    pathname = pathname.endsWith("/")
      ? `${pathname}${DEFAULT_MANIFEST_FILENAME}`
      : `${pathname}/${DEFAULT_MANIFEST_FILENAME}`;
  }
  return pathname;
}

/** Short hash of `search + hash` so two URLs that differ only in query /
 *  fragment do not collide at the same cache path. */
function disambiguatePath(pathname: string, search: string, hash: string): string {
  if (!search && !hash) return pathname;
  const digest = createHash("sha256")
    .update(search + hash)
    .digest("hex")
    .slice(0, QUERY_HASH_LENGTH);
  const dotIdx = pathname.lastIndexOf(".");
  const slashIdx = pathname.lastIndexOf("/");
  const ext = dotIdx > slashIdx ? pathname.slice(dotIdx) : "";
  const base = pathname.slice(0, pathname.length - ext.length);
  return `${base}.${digest}${ext}`;
}

interface VersionsResponse {
  versions?: string[];
}

/** The default HTTP transport: bare `namespace/name@version` registry refs and
 *  direct `https://…` URLs, resolving against `registry.telo.run` (or a
 *  configured registry). Its resolution `source` composes the browser-safe
 *  `RegistrySource` / `HttpSource` from `analyzer`; the Node-only management
 *  methods live here. This is the fallback transport for any ref that carries
 *  no owning scheme, so `oci://` (or a future `s3://`) never falls through to
 *  it — those refs are claimed by their own transport's `supports()`. */
export class RegistryTransport implements Transport {
  private readonly registrySource: RegistrySource;
  private readonly httpSource: HttpSource;
  readonly source: ManifestSource;

  constructor(private readonly registryUrl: string = DEFAULT_REGISTRY_URL) {
    this.registrySource = new RegistrySource(registryUrl);
    this.httpSource = new HttpSource();
    const pick = (ref: string): ManifestSource =>
      this.httpSource.supports(ref) ? this.httpSource : this.registrySource;
    this.source = {
      supports: (url) => this.supports(url),
      read: async (url) => {
        // The browser-safe sources do the fetch; the Node-side egress policy
        // is enforced here, on the host the read will actually hit.
        await assertPublicEgress(this.httpSource.supports(url) ? url : this.registryUrl);
        return pick(url).read(url);
      },
      resolveRelative: (base, relative) => pick(base).resolveRelative(base, relative),
    };
  }

  supports(ref: string): boolean {
    const { base } = splitIntegrity(ref);
    return base.startsWith("http://") || base.startsWith("https://") || isRegistryRef(ref);
  }

  cacheLocation(ref: string): string[] | null {
    const url = splitIntegrity(ref).base;
    const trimmedRegistry = this.registryUrl.replace(/\/+$/, "");

    // 1. Registry ref form: namespace/name@version
    if (isRegistryRef(url)) {
      let parsed: ReturnType<typeof parseModuleRef>;
      try {
        parsed = parseModuleRef(url);
      } catch {
        return null;
      }
      return [parsed.modulePath, parsed.version, DEFAULT_MANIFEST_FILENAME];
    }

    // 2. HTTP(S) URL — a direct registry URL or arbitrary external.
    if (url.startsWith("http://") || url.startsWith("https://")) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return null;
      }
      const pathname = normalizePathname(url, parsed);

      // 2a. On the configured registry, no query/fragment: fold into the
      //     registry layout so a ref and a direct URL land on the same file.
      const normalizedUrl = `${parsed.protocol}//${parsed.host}${pathname}`;
      if (
        !parsed.search &&
        !parsed.hash &&
        (normalizedUrl === trimmedRegistry || normalizedUrl.startsWith(`${trimmedRegistry}/`))
      ) {
        const rel = normalizedUrl.slice(trimmedRegistry.length + 1);
        if (!rel) return null;
        return rel.split("/");
      }

      // 2b. Arbitrary HTTP(S) → __http subtree, query-hash suffix on collision.
      const cleanPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
      const disambiguated = disambiguatePath(cleanPath, parsed.search, parsed.hash);
      return [HTTP_NAMESPACE, parsed.host, ...disambiguated.split("/")];
    }

    return null;
  }

  async listVersions(ref: string): Promise<string[] | null> {
    // Only bare registry refs are version-enumerable — a direct `https://` URL
    // has no version-list endpoint.
    if (!isRegistryRef(ref)) return null;
    const { modulePath } = parseModuleRef(ref);
    const url = `${this.registryUrl.replace(/\/+$/, "")}/${modulePath}`;
    await assertPublicEgress(url);
    const res = await fetchOrThrow(
      url,
      { headers: { accept: "application/json" } },
      { operation: "Registry version list", setting: "--registry / TELO_REGISTRY" },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Registry returned ${res.status} ${res.statusText} for ${modulePath}`);
    }
    const body = (await res.json()) as VersionsResponse;
    return Array.isArray(body.versions) ? body.versions : [];
  }

  refVersion(ref: string): string | null {
    // Only bare `namespace/name@version` refs carry an upgradeable version — a
    // direct `https://` URL has no version segment to bump.
    if (!isRegistryRef(ref)) return null;
    const { base } = splitIntegrity(ref);
    const at = base.lastIndexOf("@");
    return at > 0 ? base.slice(at + 1) : null;
  }

  withVersion(ref: string, version: string): string {
    const { modulePath } = parseModuleRef(ref);
    return `${modulePath}@${version}`;
  }

  /** Mirrors the sources' fetch-URL derivation: a direct URL points at (or
   *  contains) the YAML file; a bare registry ref folds into the registry
   *  layout. `null` when this transport does not own the ref's shape. */
  private manifestUrl(ref: string): string | null {
    const { base } = splitIntegrity(ref);
    if (base.startsWith("http://") || base.startsWith("https://")) {
      return base.includes(".yaml") ? base : `${base}/${DEFAULT_MANIFEST_FILENAME}`;
    }
    if (isRegistryRef(ref)) {
      const { modulePath, version } = parseModuleRef(ref);
      return `${this.registryUrl.replace(/\/+$/, "")}/${modulePath}/${version}/${DEFAULT_MANIFEST_FILENAME}`;
    }
    return null;
  }

  async digest(ref: string): Promise<string | null> {
    // The digest is Telo's canonical hash over the `telo.yaml` bytes — the same
    // value `manifestHash` returns, but absent-is-null rather than a throw.
    const fetchUrl = this.manifestUrl(ref);
    if (!fetchUrl) return null;
    await assertPublicEgress(fetchUrl);
    const res = await fetchOrThrow(fetchUrl, undefined, {
      operation: "Registry manifest read",
      setting: "--registry / TELO_REGISTRY",
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Registry returned ${res.status} ${res.statusText} for ${fetchUrl}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return `sha256-${await sha256Base64Url(bytes)}`;
  }

  /** Hashes the **raw response bytes**, which is exactly what `verifiedFetch`
   *  checks an inline `#sha256-…` pin against on the read path. */
  async manifestHash(ref: string): Promise<string> {
    const fetchUrl = this.manifestUrl(ref);
    if (!fetchUrl) {
      throw new Error(`cannot hash non-remote import '${ref}'`);
    }
    await assertPublicEgress(fetchUrl);
    const res = await fetchOrThrow(fetchUrl, undefined, {
      operation: "Registry manifest hash",
      setting: "--registry / TELO_REGISTRY",
    });
    if (!res.ok) {
      throw new Error(`fetch ${fetchUrl}: ${res.status} ${res.statusText}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return `sha256-${await sha256Base64Url(bytes)}`;
  }

  async fetchArtifact(ref: string): Promise<FetchedArtifact> {
    // `read` verifies the manifest bytes against the inline `#sha256-...` hash.
    const { text: manifest, source } = await this.source.read(ref);
    const meta = readOwnerManifest(manifest);
    if (!meta.declaresFiles) return { manifest, files: [] };

    // The payload rides beside the manifest as `module.tar.gz`.
    const tarUrl = source.replace(/\/telo\.yaml$/, "/module.tar.gz");
    await assertPublicEgress(tarUrl);
    const res = await fetchOrThrow(tarUrl, undefined, {
      operation: "Module payload download",
      setting: "--registry / TELO_REGISTRY",
    });
    if (!res.ok) {
      throw new Error(`could not fetch bundle ${tarUrl}: ${res.status} ${res.statusText}`);
    }
    const files = toPayloadFiles(await readTarGz(Buffer.from(await res.arrayBuffer())));

    // Verify the payload against the manifest's `filesIntegrity` before handing
    // it back — a mismatch is terminal (a tampered bundle must never be used).
    // The manifest that carries the hash is itself pinned by the inline hash.
    if (meta.filesIntegrity) {
      const actual = await computeFilesIntegrity(files);
      if (actual !== meta.filesIntegrity) {
        throw new IntegrityError(
          `Integrity check failed for bundle ${tarUrl}: filesIntegrity expected ` +
            `${meta.filesIntegrity}, got ${actual}. The payload does not match the recorded ` +
            `hash — the module may have been tampered with or republished.`,
        );
      }
    }

    return { manifest, files };
  }

  async publish(
    destination: string,
    bundle: PublishBundle,
    opts: PublishOptions = {},
  ): Promise<PublishResult> {
    // Pin the payload in the manifest before it enters the tarball, then choose
    // the artifact body: a `module.tar.gz` when there are files, else raw YAML.
    let manifest = bundle.manifest;
    let body: string | Uint8Array = manifest;
    let contentType = "text/yaml";
    let urlSuffix = "";
    if (bundle.files.length > 0) {
      manifest = injectFilesIntegrity(manifest, await computeFilesIntegrity(bundle.files));
      const entries = [
        { name: DEFAULT_MANIFEST_FILENAME, content: manifest },
        ...bundle.files.map((f) => ({ name: f.name, content: Buffer.from(f.content) })),
      ];
      body = await makeTarGz(entries);
      contentType = "application/gzip";
      urlSuffix = "/module.tar.gz";
    }

    const { namespace, name, version } = readOwnerManifest(manifest);
    if (!namespace || !name || !version) {
      throw new Error("metadata must include namespace, name, and version.");
    }
    const identity = { namespace, name, version };
    const base = `${destination.replace(/\/+$/, "")}/${identity.namespace}/${identity.name}/${identity.version}`;
    const url = `${base}${urlSuffix}`;
    const label = `${identity.namespace}/${identity.name}@${identity.version}`;

    const headers: Record<string, string> = { "content-type": contentType };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;

    let res: Response | null = null;
    let networkErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      networkErr = null;
      try {
        res = await fetchOrThrow(
          url,
          { method: "PUT", headers, body },
          { operation: "Registry publish", setting: "--registry / TELO_REGISTRY" },
        );
      } catch (err) {
        networkErr = err;
        res = null;
      }

      const transient = networkErr != null || (res != null && isRetryableStatus(res.status));
      if (!transient) break;
      if (attempt === MAX_PUSH_ATTEMPTS) break;

      const reason = networkErr
        ? `network error: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`
        : `HTTP ${res!.status}`;
      // Drain the body so the underlying connection can be reused for the retry.
      if (res) await res.text().catch(() => {});
      const delayMs = PUSH_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      opts.onRetry?.({ reason, attempt, maxAttempts: MAX_PUSH_ATTEMPTS, delayMs });
      await sleep(delayMs);
    }

    if (networkErr) {
      throw new Error(
        `Network error: ${networkErr instanceof Error ? networkErr.message : String(networkErr)} ` +
          `(after ${MAX_PUSH_ATTEMPTS} attempts)`,
      );
    }
    if (!res!.ok) {
      const ct = res!.headers.get("content-type") ?? "";
      const errBody = ct.includes("application/json") ? await res!.json() : await res!.text();
      throw new Error(`Push failed (${res!.status}): ${JSON.stringify(errBody)}`);
    }

    return { label, url };
  }

  canonicalizeSiblingRef(
    _destination: string,
    _relativeSource: string,
    sibling: SiblingIdentity,
  ): string {
    // An HTTP registry path defaults to the sibling's own `<namespace>/<name>`.
    if (!sibling.namespace || !sibling.name) {
      throw new Error(
        "a relative import canonicalized to an HTTP registry needs the sibling's metadata.namespace and metadata.name.",
      );
    }
    return `${sibling.namespace}/${sibling.name}@${sibling.version}`;
  }
}

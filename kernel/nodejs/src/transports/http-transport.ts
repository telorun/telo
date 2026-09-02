import {
  DEFAULT_MANIFEST_FILENAME,
  HttpSource,
  sha256Base64Url,
  splitIntegrity,
  type ArtifactLayer,
  type ManifestCacheCoords,
  type ManifestSource,
} from "@telorun/analyzer";
import { fetchOrThrow } from "@telorun/sdk";
import { createHash } from "crypto";

import type { PayloadFile } from "../bundle/files-integrity.js";
import { assertPublicEgress } from "./egress-guard.js";
import type {
  PayloadLayer,
  PublishBundle,
  PublishOptions,
  PublishResult,
  Transport,
} from "./transport.js";

const QUERY_HASH_LENGTH = 12;

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

/** The transport for direct `https://…` (and `http://`) module URLs. Its
 *  resolution `source` composes the browser-safe `HttpSource` from `analyzer`;
 *  the Node-only management methods live here. This is the fallback transport
 *  for any ref that carries no owning scheme, so `oci://` (or a future `s3://`)
 *  never falls through to it — those refs are claimed by their own transport's
 *  `supports()`.
 *
 *  A URL addresses exactly one file, so it names no enumerable version: this
 *  transport publishes nothing, lists no versions, and has no `@version` segment
 *  to bump. What it does own is reading, hashing and caching those bytes. */
export class HttpTransport implements Transport {
  private readonly httpSource: HttpSource;
  readonly source: ManifestSource;

  constructor() {
    this.httpSource = new HttpSource();
    this.source = {
      supports: (url) => this.supports(url),
      read: async (url) => {
        // The browser-safe source does the fetch; the Node-side egress policy
        // is enforced here, on the host the read will actually hit.
        await assertPublicEgress(url);
        return this.httpSource.read(url);
      },
      resolveRelative: (base, relative) => this.httpSource.resolveRelative(base, relative),
    };
  }

  supports(ref: string): boolean {
    const { base } = splitIntegrity(ref);
    return base.startsWith("http://") || base.startsWith("https://");
  }

  cacheCoords(ref: string): ManifestCacheCoords | null {
    const url = splitIntegrity(ref).base;
    if (!url.startsWith("http://") && !url.startsWith("https://")) return null;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const pathname = normalizePathname(url, parsed);

    // `url` subtree, query-hash suffix on collision. No version segment: a URL
    // addresses exactly one file, and the version it declares lives inside
    // bytes the cache maps paths without.
    const cleanPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    const segments = disambiguatePath(cleanPath, parsed.search, parsed.hash).split("/");
    const file = segments.pop();
    if (!file) return null;
    return { transport: "url", host: parsed.host, path: segments.join("/"), file };
  }

  async listVersions(): Promise<string[] | null> {
    // A direct `https://` URL has no version-list endpoint.
    return null;
  }

  refVersion(): string | null {
    // A direct `https://` URL has no version segment to bump.
    return null;
  }

  withVersion(ref: string): string {
    throw new Error(
      `cannot set a version on '${ref}': a URL addresses one file and carries no version segment.`,
    );
  }

  /** Mirrors the source's fetch-URL derivation: the URL points at (or contains)
   *  the YAML file. `null` when this transport does not own the ref's shape. */
  private manifestUrl(ref: string): string | null {
    const { base } = splitIntegrity(ref);
    if (!base.startsWith("http://") && !base.startsWith("https://")) return null;
    return base.includes(".yaml") ? base : `${base}/${DEFAULT_MANIFEST_FILENAME}`;
  }

  async digest(ref: string): Promise<string | null> {
    // The digest is Telo's canonical hash over the `telo.yaml` bytes — the same
    // value `manifestHash` returns, but absent-is-null rather than a throw.
    const fetchUrl = this.manifestUrl(ref);
    if (!fetchUrl) return null;
    await assertPublicEgress(fetchUrl);
    const res = await fetchOrThrow(fetchUrl, undefined, { operation: "Module manifest read" });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`${fetchUrl} returned ${res.status} ${res.statusText}`);
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
    const res = await fetchOrThrow(fetchUrl, undefined, { operation: "Module manifest hash" });
    if (!res.ok) {
      throw new Error(`fetch ${fetchUrl}: ${res.status} ${res.statusText}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return `sha256-${await sha256Base64Url(bytes)}`;
  }

  /** Layered artifacts are an OCI concept — a module reached over a plain URL is
   *  manifest-only, and its controllers come from npm. */
  async fetchLayer(ref: string, blobDigest: string): Promise<PayloadFile[]> {
    throw new Error(
      `Cannot fetch layer ${blobDigest} of ${ref}: a plain URL serves the manifest only. ` +
        `A module with a bundled payload is published as an OCI artifact (oci://host/repo).`,
    );
  }

  async layerIndex(layers: readonly PayloadLayer[]): Promise<ArtifactLayer[]> {
    // Same boundary `fetchLayer` and `publish` draw: a plain URL serves the
    // manifest only, so it frames no layer and can name no blob. An empty set is
    // not a payload, so it answers rather than throws — a manifest-only module
    // builds its payload through this transport during analysis.
    if (layers.every((layer) => layer.files.length === 0)) return [];
    throw new Error(
      "A plain URL serves the manifest only, so it cannot index payload layers. " +
        "A module with a bundled payload is published as an OCI artifact (oci://host/repo).",
    );
  }

  async publish(
    destination: string,
    bundle: PublishBundle,
    opts: PublishOptions = {},
  ): Promise<PublishResult> {
    // `telo publish` rejects a non-OCI destination up front, so this is only a
    // guard for a direct programmatic call.
    throw new Error(
      "Publishing over HTTP has been removed. Publish to an OCI registry " +
        "(oci://host/repo) instead.",
    );
  }

  canonicalizeSiblingRef(destination: string, relativeSource: string, version: string): string {
    // Canonicalizing a sibling is publish-path work, and this transport does not
    // publish — so it refuses here for the same reason `publish` does, rather
    // than computing a ref nothing could ever push. Silence would be worse than
    // useless: an `https://host/` destination has no path to resolve `../lib`
    // beside, so joining anyway yields a ref one segment short with no error.
    throw new Error(
      `Cannot canonicalize the relative import '${relativeSource}' against '${destination}': ` +
        `publishing over plain HTTP has been removed. Publish to an OCI registry ` +
        `(oci://host/repo) instead.`,
    );
  }
}

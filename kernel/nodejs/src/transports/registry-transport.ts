import {
  DEFAULT_MANIFEST_FILENAME,
  HttpSource,
  IntegrityError,
  RegistrySource,
  isRegistryRef,
  parseModuleRef,
  parseVersionedRef,
  sha256Base64Url,
  withRefVersion,
  splitIntegrity,
  type ManifestCacheCoords,
  type ManifestSource,
} from "@telorun/analyzer";
import { fetchOrThrow } from "@telorun/sdk";
import { createHash } from "crypto";

import { computeFilesIntegrity } from "../bundle/files-integrity.js";
import { readOwnerManifest } from "../bundle/module-manifest.js";
import { readTarGz, toPayloadFiles } from "../bundle/tar.js";
import { assertPublicEgress } from "./egress-guard.js";
import type {
  FetchedArtifact,
  PublishBundle,
  PublishOptions,
  PublishResult,
  Transport,
} from "./transport.js";

const DEFAULT_REGISTRY_URL = "https://registry.telo.run";
/** Throwaway origin that lets a bare registry ref use URL path resolution. */
const JOIN_ORIGIN = "https://ref.invalid";

/** True for an HTTP(S) destination that names a registry root rather than a
 *  module within it — no path segments to resolve a sibling beside. */
function isRegistryBase(base: string): boolean {
  if (!base.startsWith("http://") && !base.startsWith("https://")) return false;
  try {
    return new URL(base).pathname.replace(/\/+/g, "/").replace(/^\/|\/$/g, "") === "";
  } catch {
    return false;
  }
}
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

  cacheCoords(ref: string): ManifestCacheCoords | null {
    const url = splitIntegrity(ref).base;
    const trimmedRegistry = this.registryUrl.replace(/\/+$/, "");
    const registryHost = this.registryHost();

    // 1. Registry ref form: <path>@<version>. Keyed under the registry's host —
    //    a ref says nothing about which registry serves it, so without the host
    //    two registries' copies of the same path/version share one cache entry.
    if (isRegistryRef(url)) {
      if (!registryHost) return null;
      let parsed: ReturnType<typeof parseModuleRef>;
      try {
        parsed = parseModuleRef(url);
      } catch {
        return null;
      }
      return {
        transport: "registry",
        host: registryHost,
        path: parsed.modulePath,
        version: parsed.version,
      };
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
        registryHost &&
        !parsed.search &&
        !parsed.hash &&
        normalizedUrl.startsWith(`${trimmedRegistry}/`)
      ) {
        // The registry serves `<path…>/<version>/<file>`, where `<file>` is the
        // module manifest or one of its `include:` partials.
        const segments = normalizedUrl.slice(trimmedRegistry.length + 1).split("/");
        const file = segments.pop();
        const version = segments.pop();
        if (file && version && segments.length > 0) {
          return {
            transport: "registry",
            host: registryHost,
            path: segments.join("/"),
            version,
            file,
          };
        }
      }

      // 2b. Arbitrary HTTP(S) → `url` subtree, query-hash suffix on collision.
      //     No version segment: a URL addresses exactly one file, and the
      //     version it declares lives inside bytes the cache maps paths without.
      const cleanPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
      const segments = disambiguatePath(cleanPath, parsed.search, parsed.hash).split("/");
      const file = segments.pop();
      if (!file) return null;
      return { transport: "url", host: parsed.host, path: segments.join("/"), file };
    }

    return null;
  }

  /** Host of the configured registry, or `null` when the URL is unparseable. */
  private registryHost(): string | null {
    try {
      return new URL(this.registryUrl).host || null;
    } catch {
      return null;
    }
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
    return isRegistryRef(ref) ? (parseVersionedRef(ref)?.version ?? null) : null;
  }

  withVersion(ref: string, version: string): string {
    return withRefVersion(ref, version);
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
    // Publishing to the HTTP Telo registry has been removed — the registry
    // origin stays read-only, and new versions publish to OCI. `telo publish`
    // rejects a non-OCI destination up front, so this is only a guard for a
    // direct programmatic call.
    throw new Error(
      "Publishing to the HTTP Telo registry has been removed. Publish to an OCI " +
        "registry (oci://host/repo) instead.",
    );
  }

  canonicalizeSiblingRef(
    destination: string,
    relativeSource: string,
    version: string,
  ): string {
    // The sibling sits beside the destination module: resolve the relative path
    // against the destination's own path, then pin the sibling's version. A bare
    // registry ref (`std/foo`) is a path, not a URL, so it borrows a throwaway
    // origin for the join and drops it again.
    const base = splitIntegrity(destination).base.replace(/@[^/@]*$/, "");
    // A registry *base* (`https://registry.telo.run`) is not a module location,
    // so there is nothing for `../lib` to resolve beside — joining anyway would
    // silently produce a ref one path segment short.
    if (isRegistryBase(base)) {
      throw new Error(
        `cannot canonicalize the relative import '${relativeSource}': publish destination ` +
          `'${destination}' is a registry base, not this module's own location. Pass the ` +
          `module's full destination (e.g. '${base.replace(/\/+$/, "")}/<namespace>/<name>').`,
      );
    }
    const isUrl = base.startsWith("http://") || base.startsWith("https://");
    const origin = isUrl ? base : `${JOIN_ORIGIN}/${base.replace(/^\/+/, "")}`;
    const resolved = new URL(relativeSource, `${origin.replace(/\/+$/, "")}/`);
    const joined = isUrl
      ? `${resolved.protocol}//${resolved.host}${resolved.pathname}`
      : resolved.pathname.replace(/^\/+/, "");
    return `${joined.replace(/\/+$/, "")}@${version}`;
  }
}

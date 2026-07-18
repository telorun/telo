import type { ManifestSource } from "../types.js";
import { DEFAULT_MANIFEST_FILENAME } from "../types.js";
import { splitIntegrity, verifiedFetch } from "./integrity.js";
import { OCI_SCHEME, isOciRef, parseOciRef } from "./oci-ref.js";

/** The hub's static manifest cache: an R2 bucket bound directly to the domain,
 *  serving each tracked module version's `telo.yaml` at a deterministic key.
 *  Read plane only — never artifact payloads; install/run stay origin-direct. */
export const MANIFEST_CACHE_BASE_URL = "https://manifests.telo.sh";

/** The location identity of one cached module version. Mirrors what the hub
 *  stores per version — `{ transport, host, path, version }` — so the tracker's
 *  write key and the editor's read key come from the same function and never
 *  drift. `path` is the slash-separated repo/module path (multi-segment OCI
 *  repos nest as prefixes). */
export interface ManifestCacheCoords {
  transport: string;
  host: string;
  path: string;
  version: string;
}

/** True for a segment that would corrupt or escape the cache key space. */
function invalidSegment(segment: string): boolean {
  return segment === "" || segment === "." || segment === ".." || segment.includes("\\");
}

/** Deterministic cache key for one module version:
 *  `<transport>/<host>/<path…>/<version>/telo.yaml`. Returns `null` when any
 *  coordinate is empty or would traverse out of the key space. */
export function manifestCacheKey(coords: ManifestCacheCoords): string | null {
  const { transport, host, path, version } = coords;
  const segments = [transport, host, ...path.split("/"), version];
  if (segments.some(invalidSegment) || transport.includes("/") || host.includes("/") || version.includes("/")) {
    return null;
  }
  return `${segments.join("/")}/${DEFAULT_MANIFEST_FILENAME}`;
}

/** Cache coordinates for an `oci://host/repo@tag` ref. Returns `null` when the
 *  ref carries no explicit tag (a defaulted `latest` or a `sha256:` digest is
 *  not addressable — the cache is keyed by the human version tag the tracker
 *  enumerated). The inline `#sha256-…` fragment is tolerated and ignored. */
export function ociManifestCacheCoords(ref: string): ManifestCacheCoords | null {
  if (!isOciRef(ref)) return null;
  let parsed: ParsedOciRefShape;
  try {
    parsed = parseOciRef(ref);
  } catch {
    return null;
  }
  const { base } = splitIntegrity(ref);
  const explicitTag = base.endsWith(`@${parsed.reference}`) && !parsed.reference.includes(":");
  if (!explicitTag) return null;
  return { transport: "oci", host: parsed.host, path: parsed.repo, version: parsed.reference };
}

type ParsedOciRefShape = ReturnType<typeof parseOciRef>;

/** True for a direct `https://` module manifest ref. Plaintext `http://` is
 *  deliberately excluded — the hub serves cached third-party manifests onward,
 *  so it never ingests over an unauthenticated channel. */
export function isHttpsModuleRef(ref: string): boolean {
  return splitIntegrity(ref).base.startsWith("https://");
}

/** Cache coordinates for a direct `https://host/path/telo.yaml` ref.
 *
 *  Unlike OCI, a URL carries no version — a URL addresses one file whose
 *  version lives *inside* it (`metadata.version`) — so the caller passes the
 *  version it read from the manifest. Returns `null` for a non-https ref, a
 *  URL that carries a query or userinfo (both would let two distinct URLs
 *  collide onto one key, or smuggle a host), or an unparseable URL.
 *
 *  A trailing `telo.yaml` segment is dropped: the key appends the manifest
 *  filename itself, so carrying it in `path` would duplicate it. */
export function urlManifestCacheCoords(ref: string, version: string): ManifestCacheCoords | null {
  const { base } = splitIntegrity(ref);
  if (!isHttpsModuleRef(base)) return null;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  // `username`/`password` would mean the authority is not what it looks like
  // (`https://evil.com@internal/…`); a query would make the key ambiguous.
  if (parsed.search !== "" || parsed.username !== "" || parsed.password !== "") return null;

  const segments = parsed.pathname.split("/").filter((s) => s !== "");
  if (segments[segments.length - 1] === DEFAULT_MANIFEST_FILENAME) segments.pop();
  if (segments.length === 0 || parsed.hostname === "") return null;

  return {
    transport: "url",
    host: parsed.host,
    path: segments.map((s) => decodeURIComponent(s)).join("/"),
    version,
  };
}

/** Full cache URL for a ref or coordinates, or `null` when not addressable. */
export function manifestCacheUrl(
  refOrCoords: string | ManifestCacheCoords,
  baseUrl: string = MANIFEST_CACHE_BASE_URL,
): string | null {
  const coords = typeof refOrCoords === "string" ? ociManifestCacheCoords(refOrCoords) : refOrCoords;
  if (!coords) return null;
  const key = manifestCacheKey(coords);
  return key ? `${baseUrl.replace(/\/+$/, "")}/${key}` : null;
}

/** Resolves `oci://` module refs against the hub's static manifest cache with a
 *  plain CORS GET — a browser can't speak the OCI protocol, so this is the
 *  browser-safe read path for OCI imports. A pinned ref (`#sha256-…`) is
 *  verified against the fetched bytes, so a compromised cache can't mislead
 *  analysis; an unpinned ref is analyzed on trust — the security boundary is
 *  install/run (origin-direct, re-verified), not edit time. */
export class ManifestCacheSource implements ManifestSource {
  constructor(private readonly baseUrl: string = MANIFEST_CACHE_BASE_URL) {}

  supports(url: string): boolean {
    // Claim every oci:// ref, addressable or not — nothing else browser-safe
    // can ever resolve one, so an untagged/digest ref must reach `read()`'s
    // actionable error instead of falling through to a file-not-found from a
    // local/HTTP source.
    return isOciRef(url);
  }

  async read(ref: string): Promise<{ text: string; source: string }> {
    const { integrity } = splitIntegrity(ref);
    const coords = ociManifestCacheCoords(ref);
    const fetchUrl = coords && manifestCacheUrl(coords, this.baseUrl);
    if (!fetchUrl) {
      throw new Error(
        `Cannot resolve '${ref}' from the manifest cache — an oci:// import needs an explicit version tag (oci://host/repo@version)`,
      );
    }
    const { text } = await verifiedFetch(fetchUrl, integrity, ref);
    return { text, source: `${OCI_SCHEME}${coords.host}/${coords.path}@${coords.version}` };
  }

  /** Mirror of the kernel OCI transport's resolution: normalize the repo to a
   *  directory base so `../lib` under `oci://ghcr.io/aws/my-app` →
   *  `oci://ghcr.io/aws/lib`. The tag is dropped — the caller re-pins from the
   *  sibling's own version. Non-relative refs pass through. */
  resolveRelative(base: string, relative: string): string {
    if (!relative.startsWith(".") && !relative.startsWith("/")) return relative;
    const { host, repo } = parseOciRef(base);
    const resolved = new URL(relative, `https://${host}/${repo}/`);
    const newRepo = resolved.pathname.replace(/^\/+/, "");
    return `${OCI_SCHEME}${host}/${newRepo}`;
  }
}

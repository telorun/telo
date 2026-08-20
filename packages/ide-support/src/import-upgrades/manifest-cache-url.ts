import {
  MANIFEST_CACHE_BASE_URL,
  isOciRef,
  manifestCacheUrl,
  urlManifestCacheCoords,
  withRefVersion,
} from "@telorun/analyzer";

/**
 * Where one version of a module's `telo.yaml` can be read from the hub's static
 * manifest cache, or `null` when this ref is not addressable there.
 *
 * This is the read path an upgrade check uses to ask a candidate version what
 * runtime it requires: a plain CORS GET of a single small file, no transport
 * protocol and no artifact payload, so it works identically from a browser and
 * from an extension host. The `fetch` itself stays with the host — everything
 * in this package leaves the network to its caller.
 *
 * A ref the cache cannot address (a registry ref, whose origin this side does
 * not know; a URL with no version segment) returns `null`, which the caller
 * reads as "not known" and never as "incompatible". Losing the check for those
 * refs is the honest outcome: the manifest is still gated at load time.
 */
export function moduleManifestCacheUrl(
  baseRef: string,
  version: string,
  baseUrl: string = MANIFEST_CACHE_BASE_URL,
): string | null {
  if (isOciRef(baseRef)) {
    let versioned: string;
    try {
      versioned = withRefVersion(baseRef, version);
    } catch {
      return null;
    }
    return manifestCacheUrl(versioned, baseUrl);
  }
  const coords = urlManifestCacheCoords(baseRef, version);
  return coords ? manifestCacheUrl(coords, baseUrl) : null;
}

import { defaultTransportRegistry } from "@telorun/kernel";

/**
 * Fetch a remote import's published `telo.yaml` and return its integrity hash
 * (`sha256-<base64url>`). Used by `telo publish` for import pinning. Throws when
 * no transport owns the ref or the fetch fails — callers decide whether that is
 * fatal (`--frozen`) or best-effort.
 *
 * Dispatch is the transport registry, never a scheme branch here: each
 * transport hashes exactly what its own `read()` verifies (registry/HTTP the
 * raw bytes, OCI the UTF-8 text extracted from the tar layer), so a pin written
 * at publish always matches at import. A caller-side branch cannot know which,
 * and silently degrades the moment a transport is added — that is precisely how
 * `oci://` refs came to be published unpinned.
 */
export async function fetchManifestHash(registryUrl: string, ref: string): Promise<string> {
  const transport = defaultTransportRegistry(registryUrl).forRef(ref);
  if (!transport) {
    throw new Error(`cannot hash non-remote import '${ref}'`);
  }
  return transport.manifestHash(ref);
}

import { isRegistryRef, parseModuleRef, sha256Base64Url } from "@telorun/analyzer";

/**
 * Fetch a remote import's published `telo.yaml` and return its integrity hash
 * (`sha256-<base64url>`). Builds the URL exactly as `RegistrySource` does and
 * hashes the raw response bytes, so the value matches what the consumer's
 * `read()` verifies. Used by `telo publish` (import pinning) and `telo upgrade`
 * (re-pin on version change). Throws when the ref is not remote or the fetch
 * fails — callers decide whether that is fatal (`--frozen`) or best-effort.
 */
export async function fetchManifestHash(registryUrl: string, ref: string): Promise<string> {
  const trimmed = registryUrl.replace(/\/+$/, "");
  let url: string;
  if (isRegistryRef(ref)) {
    const { modulePath, version } = parseModuleRef(ref);
    url = `${trimmed}/${modulePath}/${version}/telo.yaml`;
  } else if (ref.startsWith("http://") || ref.startsWith("https://")) {
    url = ref.includes(".yaml") ? ref : `${ref.replace(/\/+$/, "")}/telo.yaml`;
  } else {
    throw new Error(`cannot hash non-remote import '${ref}'`);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return `sha256-${await sha256Base64Url(bytes)}`;
}

import { HttpSource, ManifestCacheSource, type ManifestSource } from "@telorun/analyzer";
import type { RemoteReader } from "@telorun/language-host";

/**
 * Every non-`file:` read the engine asks for, through the transports studio's
 * own loader uses: `oci://` against the hub's manifest cache (a browser cannot
 * speak OCI; a pinned ref is verified against the fetched bytes), `https://`
 * directly. `settingsSources` is read per request, so a changed manifest-cache
 * setting applies to the next read.
 */
export function remoteManifestReader(settingsSources: () => ManifestSource[]): RemoteReader {
  const builtIn: ManifestSource[] = [new ManifestCacheSource(), new HttpSource()];
  return async (uri) => {
    const source = [...settingsSources(), ...builtIn].find((s) => s.supports(uri));
    if (!source) throw new Error(`studio has no transport for '${uri}'.`);
    const { text, source: resolved } = await source.read(uri);
    return { uri: resolved, text };
  };
}

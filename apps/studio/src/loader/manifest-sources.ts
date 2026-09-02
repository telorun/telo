import type { ManifestSource } from "@telorun/analyzer";
import { ManifestCacheSource } from "@telorun/analyzer";
import type { AppSettings } from "../model";

/** The settings-derived manifest sources the editor prepends to its loader.
 *
 *  A browser can't speak the OCI protocol, so `oci://` imports resolve against
 *  the hub's static manifest cache. A custom endpoint (a self-hosted hub) is
 *  returned here so it precedes the loader's built-in default and wins; with
 *  none configured the list is empty and the default applies. */
export function createManifestSources(settings: AppSettings): ManifestSource[] {
  const endpoint = settings.manifestCacheUrl?.trim();
  return endpoint ? [new ManifestCacheSource(endpoint)] : [];
}

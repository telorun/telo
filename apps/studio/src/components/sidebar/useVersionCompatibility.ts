import {
  createVersionCompatibility,
  moduleManifestCacheUrl,
  type VersionCompatibilityCheck,
} from "@telorun/ide-support";
import { useMemo } from "react";

/** Reads one version's `telo.yaml` from the static manifest cache — the only
 *  module read path a browser has, and the same one the VS Code lenses take, so
 *  both IDEs answer "can this telo host it" identically.
 *
 *  A ref the cache cannot address (a registry ref, whose origin the editor does
 *  not know) answers `null`, which reads as "not known" and never as
 *  incompatible: an editor that cannot check must not freeze an author's
 *  imports. The manifest is still gated at load time. */
function readManifest(
  baseRef: string,
  version: string,
  cacheBaseUrl: string | undefined,
): Promise<string | null> {
  const url = moduleManifestCacheUrl(baseRef, version, cacheBaseUrl);
  if (!url) return Promise.resolve(null);
  return fetch(url).then((res) => (res.ok ? res.text() : null));
}

/** One compatibility check, memoized per module and version, shared by every
 *  affordance in the Imports view.
 *
 *  Shared on purpose: the badge asks about the newest version, and opening the
 *  picker asks about the same one again. A published version's declared
 *  requirement is immutable, so a second read could only ever return the same
 *  answer — and this view re-renders on every analysis pass. */
export function useVersionCompatibility(
  manifestCacheUrl: string | undefined,
): VersionCompatibilityCheck {
  return useMemo(() => {
    const base = manifestCacheUrl?.trim() || undefined;
    return createVersionCompatibility((baseRef, version) =>
      readManifest(baseRef, version, base),
    );
  }, [manifestCacheUrl]);
}

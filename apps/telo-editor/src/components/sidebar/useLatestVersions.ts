import { useEffect, useState } from "react";
import { fetchLatestVersion, parseRegistryRef } from "../../loader";
import type { ParsedImport, RegistryServer } from "../../model";

/** Resolves the registry-computed latest version for every distinct registry
 *  module referenced by the given imports, so the Imports view can flag those
 *  that are behind. Fetches each `moduleId` once; non-registry imports are
 *  skipped. The map is keyed by `moduleId` (e.g. `std/console`). */
export function useLatestVersions(
  imports: ParsedImport[],
  registryServers: RegistryServer[],
): Map<string, string> {
  const [latest, setLatest] = useState<Map<string, string>>(new Map());

  const moduleIds = [
    ...new Set(
      imports
        .map((imp) => (imp.importKind === "registry" ? parseRegistryRef(imp.source)?.moduleId : null))
        .filter((id): id is string => id != null),
    ),
  ];
  const key = moduleIds.join(",");

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      moduleIds.map(async (moduleId) => {
        const version = await fetchLatestVersion(moduleId, registryServers);
        return [moduleId, version] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next = new Map<string, string>();
      for (const [moduleId, version] of entries) {
        if (version) next.set(moduleId, version);
      }
      setLatest(next);
    });
    return () => {
      cancelled = true;
    };
    // moduleIds is derived from `key`; registryServers identity is stable per render.
  }, [key, registryServers]);

  return latest;
}

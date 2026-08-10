import { isSameModuleVersion, newestModuleVersion, parseVersionedRef } from "@telorun/analyzer";
import { useEffect, useState } from "react";
import { fetchHubVersions, type ModuleVersion } from "../../hub-search";
import type { ParsedImport } from "../../model";

/** Resolves the latest tracked version for every distinct versioned module the
 *  given imports reference, so the Imports view can flag those that are behind.
 *  Fetches each ref once; imports that name no version (local paths, bare URLs,
 *  untagged OCI refs) are skipped. The map is keyed by the version-independent
 *  base ref (`acme/console`, `oci://ghcr.io/telorun/timer`) — the same identity
 *  the hub registers a module under, so every transport is treated alike.
 *
 *  The value is the whole {@link ModuleVersion}, not just its name: the hub
 *  reports an integrity pin per version, and an upgrade that dropped it would
 *  leave the import unpinned. A browser cannot recompute that hash for any
 *  transport, so the one the hub already published is the only pin the editor
 *  can write. */
export function useLatestVersions(
  imports: ParsedImport[],
  hubUrl: string | undefined,
): Map<string, ModuleVersion> {
  const [latest, setLatest] = useState<Map<string, ModuleVersion>>(new Map());

  const baseRefs = [
    ...new Set(
      imports
        .map((imp) => parseVersionedRef(imp.source)?.baseRef)
        .filter((ref): ref is string => ref != null),
    ),
  ];
  const key = baseRefs.join(",");

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      baseRefs.map(async (baseRef) => {
        try {
          // Derived through the shared ordering rather than read off the head
          // of the list: `isNewerModuleVersion` decides whether the badge
          // appears, so the same rule has to decide what it upgrades TO. Taking
          // index 0 also surfaced prereleases as automatic upgrade targets,
          // which neither `telo upgrade` nor the VS Code lenses do — the
          // per-import dropdown still lists every version for a deliberate pick.
          const versions = await fetchHubVersions(hubUrl, baseRef);
          const newest = newestModuleVersion(versions.map((v) => v.version));
          const picked = newest
            ? versions.find((v) => isSameModuleVersion(v.version, newest))
            : undefined;
          return [baseRef, picked ?? null] as const;
        } catch (err) {
          // Best-effort: the badge is background information, and an
          // unreachable hub must not blank the whole Imports view. The
          // per-import version dropdown surfaces the failure directly.
          console.warn(`telo: hub version lookup failed for ${baseRef}: ${errText(err)}`);
          return [baseRef, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next = new Map<string, ModuleVersion>();
      for (const [baseRef, version] of entries) {
        if (version) next.set(baseRef, version);
      }
      setLatest(next);
    });
    return () => {
      cancelled = true;
    };
    // baseRefs is derived from `key`.
  }, [key, hubUrl]);

  return latest;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { parseVersionedRef } from "@telorun/analyzer";
import { useEffect, useState } from "react";
import { fetchHubVersions } from "../../hub-search";
import type { ParsedImport } from "../../model";

/** Resolves the latest tracked version for every distinct versioned module the
 *  given imports reference, so the Imports view can flag those that are behind.
 *  Fetches each ref once; imports that name no version (local paths, bare URLs,
 *  untagged OCI refs) are skipped. The map is keyed by the version-independent
 *  base ref (`std/console`, `oci://ghcr.io/telorun/timer`) — the same identity
 *  the hub registers a module under, so every transport is treated alike. */
export function useLatestVersions(
  imports: ParsedImport[],
  hubUrl: string | undefined,
): Map<string, string> {
  const [latest, setLatest] = useState<Map<string, string>>(new Map());

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
          // The hub returns versions newest-first, so index 0 is the latest.
          const versions = await fetchHubVersions(hubUrl, baseRef);
          return [baseRef, versions[0] ?? null] as const;
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
      const next = new Map<string, string>();
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

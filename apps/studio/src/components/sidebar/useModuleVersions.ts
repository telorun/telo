import type { ModuleVersionLookup } from "@telorun/ide-support";
import { useMemo } from "react";
import { fetchHubVersions, type ModuleVersion } from "../../hub-search";

/** How long a module's version list stays usable before the hub is asked again.
 *  The Imports view re-derives its affordances on every analysis pass, and a
 *  dropdown re-asks each time it opens, so an uncached lookup puts the hub on
 *  the keystroke path. Module versions move on a release cadence, so
 *  minutes-stale is invisible — the same policy, and the same reasoning, as the
 *  VS Code lenses' `VERSION_TTL_MS`. */
const VERSION_TTL_MS = 5 * 60 * 1000;

/** How long a FAILED lookup is remembered. A failure has to be cached too, or
 *  the throttle vanishes exactly when the network is worst. Shorter than the
 *  success TTL so a transient outage clears quickly — unlike a compatibility
 *  verdict, a version list is expected to change, so it is re-asked either way. */
const FAILURE_TTL_MS = 30 * 1000;

interface Entry {
  at: number;
  /** Held as the promise, so the several imports of one module that resolve
   *  concurrently share a single request instead of racing. */
  versions: Promise<ModuleVersion[]>;
  failed?: boolean;
}

/** One cache per hub, module-scoped rather than per component instance.
 *
 *  The surfaces that ask are mounted and unmounted independently — the graph's
 *  declarations rail and the Outline's import table live in different tabs — so
 *  a cache inside the memo was one cache EACH, discarded on every tab switch.
 *  The TTL is what bounds staleness; the component's lifetime was never the
 *  right bound. */
const CACHES = new Map<string, Map<string, Entry>>();

function cacheFor(hubUrl: string | undefined): Map<string, Entry> {
  const key = hubUrl ?? "";
  const existing = CACHES.get(key);
  if (existing) return existing;
  const created = new Map<string, Entry>();
  CACHES.set(key, created);
  return created;
}

/**
 * One hub version lookup, memoized per module ref.
 *
 * Every affordance asks the same question about the same modules: the upgrade
 * badge resolves each import, the picker re-asks when it opens, and the
 * add-import dialog asks again for the module it is about to add. Without this
 * they were separate requests — and two aliases naming one module were two more
 * — which is what the per-ref dedup in the code this replaced was for.
 */
export function useModuleVersions(hubUrl: string | undefined): ModuleVersionLookup {
  return useMemo(() => {
    const byRef = cacheFor(hubUrl);
    return (baseRef) => {
      const now = Date.now();
      const hit = byRef.get(baseRef);
      if (hit && now - hit.at < (hit.failed ? FAILURE_TTL_MS : VERSION_TTL_MS)) {
        return hit.versions;
      }

      const versions = fetchHubVersions(hubUrl, baseRef);
      const entry: Entry = { at: now, versions };
      byRef.set(baseRef, entry);
      // Demote THIS entry, never whatever is in the map when the rejection
      // lands: an elapsed TTL between the request and its failure can have
      // installed a newer lookup, and demoting that one would re-open the
      // per-render retry the TTL exists to close.
      versions.catch(() => {
        if (byRef.get(baseRef) === entry) entry.failed = true;
      });
      return versions;
    };
  }, [hubUrl]);
}

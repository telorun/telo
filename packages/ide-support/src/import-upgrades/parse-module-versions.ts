import { isCanonicalIntegrity } from "@telorun/analyzer";
import type { ModuleVersion } from "./build-import-upgrades.js";

/**
 * Read the hub's `GET /module/versions` payload into {@link ModuleVersion}s,
 * newest first (the route's own ordering, preserved).
 *
 * Pure — the host owns the `fetch`, as everything else in this package does.
 * It lives here rather than in each host because the shape is this package's:
 * three hosts parsing the same route by hand is how one of them was left
 * filtering for strings after the route started returning objects, which
 * TypeScript could not catch behind the response cast and which surfaced only
 * as a silently empty version list.
 *
 * Tolerant by design: an entry with no usable `version` is dropped rather than
 * throwing, and an `integrity` that is not a canonical `sha256-<base64url>` is
 * discarded rather than carried — a pin is spliced into the author's YAML, so a
 * malformed one has to become "no pin", never corrupt text.
 */
export function parseModuleVersions(payload: unknown): ModuleVersion[] {
  const versions = (payload as { versions?: unknown } | null | undefined)?.versions;
  if (!Array.isArray(versions)) return [];

  return versions.flatMap((entry) => {
    const version = (entry as { version?: unknown } | null)?.version;
    if (typeof version !== "string" || version === "") return [];
    const integrity = (entry as { integrity?: unknown }).integrity;
    return [isCanonicalIntegrity(integrity) ? { version, integrity } : { version }];
  });
}

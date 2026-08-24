import { isNewerModuleVersion, newestModuleVersion, parseVersionedRef } from "@telorun/analyzer";
import {
  selectCompatibleVersion,
  type IncompatibilityReason,
  type ModuleVersion,
  type ModuleVersionLookup,
  type VersionCompatibilityCheck,
} from "@telorun/ide-support";
import { useEffect, useState } from "react";
import type { ParsedImport } from "../../model";

/** What an upgrade would do to one import, or why it would do nothing. */
export interface UpgradeTarget {
  currentVersion: string;
  /** The newest published version when it is newer than the current one, else
   *  `null` — this is what "Outdated" means, independent of whether anything
   *  can be offered. */
  newest: string | null;
  /** The newest version this telo can host, when it is newer than the current
   *  one. `null` means there is nothing to offer: either the import is current,
   *  or every newer version needs a newer telo. */
  best: ModuleVersion | null;
  /** A newer version that exists and was not offered, with the cause the check
   *  established. Surfaced in the UI: an upgrade that silently stops short of
   *  the newest version reads as the editor being broken. */
  heldBack: { version: string; reason: IncompatibilityReason } | null;
}

/** Resolves, per import, which version an upgrade would move it to.
 *
 *  Keyed by import alias rather than by module ref because "newer than what"
 *  is a property of the import, not of the module — two aliases may name the
 *  same module at different versions. Both inputs are memoized by the caller
 *  (`useModuleVersions` per ref, `useVersionCompatibility` per ref+version), so
 *  resolving per import costs one request per distinct module, not per alias.
 *
 *  The rule itself is `@telorun/ide-support`'s, shared with the VS Code upgrade
 *  lenses: which version an import moves to must not depend on which IDE is
 *  asking. */
export function useUpgradeTargets(
  imports: ParsedImport[],
  listVersions: ModuleVersionLookup,
  isCompatible: VersionCompatibilityCheck,
): Map<string, UpgradeTarget> {
  const [targets, setTargets] = useState<Map<string, UpgradeTarget>>(new Map());

  // A printable separator, and the pair is JSON-encoded so neither field can
  // forge a boundary. A control character here made git read the whole file as
  // binary — no diff, no blame, no three-way merge.
  const key = JSON.stringify(imports.map((imp) => [imp.name, imp.source]));

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      imports.map(async (imp): Promise<readonly [string, UpgradeTarget] | null> => {
        const ref = parseVersionedRef(imp.source);
        if (!ref) return null;
        try {
          const versions = await listVersions(ref.baseRef);
          const newest = newestModuleVersion(versions.map((v) => v.version));
          if (!newest || !isNewerModuleVersion(newest, ref.version)) {
            return [
              imp.name,
              { currentVersion: ref.version, newest: null, best: null, heldBack: null },
            ] as const;
          }
          const { best, heldBack } = await selectCompatibleVersion(
            ref.baseRef,
            versions,
            ref.version,
            isCompatible,
          );
          return [imp.name, { currentVersion: ref.version, newest, best, heldBack }] as const;
        } catch (err) {
          // Best-effort: the badge is background information, and an
          // unreachable hub must not blank the whole Imports view. The
          // per-import version dropdown surfaces the failure directly.
          console.warn(`telo: hub version lookup failed for ${ref.baseRef}: ${errText(err)}`);
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next = new Map<string, UpgradeTarget>();
      for (const entry of entries) {
        if (entry) next.set(entry[0], entry[1]);
      }
      setTargets(next);
    });
    return () => {
      cancelled = true;
    };
    // `imports` is derived from `key`.
  }, [key, listVersions, isCompatible]);

  return targets;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

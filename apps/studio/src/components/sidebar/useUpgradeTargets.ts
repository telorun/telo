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

/** What an upgrade would do to the import written as `source`, or `null` when
 *  the source names no version. Throws when the hub cannot answer.
 *
 *  The rule itself is `@telorun/ide-support`'s, shared with the VS Code upgrade
 *  lenses: which version an import moves to must not depend on which IDE is
 *  asking. */
export async function resolveUpgradeTarget(
  source: string,
  listVersions: ModuleVersionLookup,
  isCompatible: VersionCompatibilityCheck,
): Promise<UpgradeTarget | null> {
  const ref = parseVersionedRef(source);
  if (!ref) return null;
  const versions = await listVersions(ref.baseRef);
  const newest = newestModuleVersion(versions.map((v) => v.version));
  if (!newest || !isNewerModuleVersion(newest, ref.version)) {
    return { currentVersion: ref.version, newest: null, best: null, heldBack: null };
  }
  const { best, heldBack } = await selectCompatibleVersion(
    ref.baseRef,
    versions,
    ref.version,
    isCompatible,
  );
  return { currentVersion: ref.version, newest, best, heldBack };
}

/** Resolves, per import, which version an upgrade would move it to.
 *
 *  Keyed by import alias rather than by module ref because "newer than what"
 *  is a property of the import, not of the module — two aliases may name the
 *  same module at different versions. Both inputs are memoized by the caller
 *  (`useModuleVersions` per ref, `useVersionCompatibility` per ref+version), so
 *  resolving per import costs one request per distinct module, not per alias. */
/** An import whose version could not be checked, and why. */
export interface ImportLookupFailure {
  source: string;
  reason: string;
}

export interface UpgradeTargets {
  /** Keyed by import alias. */
  targets: Map<string, UpgradeTarget>;
  /** Imports the hub could not answer for. Reported, never dropped. */
  failures: ImportLookupFailure[];
}

export function useUpgradeTargets(
  imports: ParsedImport[],
  listVersions: ModuleVersionLookup,
  isCompatible: VersionCompatibilityCheck,
): UpgradeTargets {
  const [targets, setTargets] = useState<Map<string, UpgradeTarget>>(new Map());
  const [failures, setFailures] = useState<ImportLookupFailure[]>([]);

  // A printable separator, and the pair is JSON-encoded so neither field can
  // forge a boundary. A control character here made git read the whole file as
  // binary — no diff, no blame, no three-way merge.
  const key = JSON.stringify(imports.map((imp) => [imp.name, imp.source]));

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      imports.map(async (imp): Promise<ImportLookupResult> => {
        try {
          const target = await resolveUpgradeTarget(imp.source, listVersions, isCompatible);
          return target ? { kind: "target", name: imp.name, target } : { kind: "none" };
        } catch (err) {
          return { kind: "failure", failure: { source: imp.source, reason: errText(err) } };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const next = new Map<string, UpgradeTarget>();
      const lookupFailures: ImportLookupFailure[] = [];
      for (const result of results) {
        if (result.kind === "target") next.set(result.name, result.target);
        else if (result.kind === "failure") lookupFailures.push(result.failure);
      }
      setTargets(next);
      setFailures(lookupFailures);
    });
    return () => {
      cancelled = true;
    };
    // `imports` is derived from `key`.
  }, [key, listVersions, isCompatible]);

  return { targets, failures };
}

type ImportLookupResult =
  | { kind: "none" }
  | { kind: "target"; name: string; target: UpgradeTarget }
  | { kind: "failure"; failure: ImportLookupFailure };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

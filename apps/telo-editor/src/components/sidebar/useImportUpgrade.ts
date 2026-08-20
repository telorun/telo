import { parseVersionedRef } from "@telorun/analyzer";
import {
  markVersionCompatibility,
  noneRunnableReason,
  type IncompatibilityReason,
  type MarkedVersion,
  type ModuleVersionLookup,
  type VersionCompatibilityCheck,
} from "@telorun/ide-support";
import { useCallback, useRef, useState } from "react";
import type { ModuleVersion } from "../../hub-search";
import type { ParsedImport } from "../../model";
import { isImportPinned, upgradedImportSource } from "./import-pin";

export interface ImportUpgradeState {
  /** Name of the import whose versions are currently loaded, or null. */
  activeName: string | null;
  /** Versions for that import, newest first (the hub's ordering), each with the
   *  integrity pin the hub publishes for it and this runtime's verdict on it.
   *  Every version is listed — a picker is a deliberate choice, and an author
   *  may knowingly pin a version for a telo they are about to have — but one
   *  this telo cannot host is marked rather than offered silently. */
  versions: MarkedVersion[];
  /** Why nothing in `versions` can run here, or null when something can. A list
   *  where every row is marked explains nothing on its own, so the picker states
   *  it outright — and the two causes call for different actions. */
  noneRunnable: IncompatibilityReason | null;
  loading: boolean;
  /** Why the version list could not be loaded. Rendered inside the dropdown
   *  that asked for it. */
  error: string | null;
  submitting: boolean;
  /** Why the last upgrade attempt failed. Rendered as a view-level banner: an
   *  upgrade can be applied from the button without ever opening a dropdown, so
   *  it must not depend on a menu being on screen to be seen. */
  submitError: string | null;
  /** Set after an applied upgrade that left a previously-pinned import with no
   *  pin, so the view can say so — the rewrite is otherwise invisible in the
   *  YAML. */
  pinNotice: string | null;
  dismissNotices(): void;
  /** Fetch the available versions for an import (called when its menu opens). */
  loadVersions(imp: ParsedImport): Promise<void>;
  /** Re-point one import at `version`, carrying that version's pin. */
  selectVersion(imp: ParsedImport, version: ModuleVersion): Promise<void>;
  /** Re-point many imports in one persist cycle ("Upgrade all"). */
  upgradeAll(updates: BulkUpgrade[]): Promise<void>;
}

/** One entry of an "Upgrade all" batch. `wasPinned` / `repinned` are the
 *  caller's reading of the import it replaces and of what replaces it, so the
 *  batch can report the entries that came out unpinned. */
export interface BulkUpgrade {
  name: string;
  newSource: string;
  wasPinned: boolean;
  repinned: boolean;
}

/** The number of upgraded imports left unpinned, phrased for the banner. */
function pinDroppedMessage(count: number): string {
  return (
    `Upgraded ${count} import${count === 1 ? "" : "s"} without an integrity pin — ` +
    `the hub publishes no hash for the version ${count === 1 ? "it now names" : "they now name"}, ` +
    `and the previous pin covers the version that was replaced. ` +
    `Run \`telo upgrade\` to re-pin.`
  );
}

export function useImportUpgrade(
  listVersions: ModuleVersionLookup,
  isCompatible: VersionCompatibilityCheck,
  onUpgradeImport: (name: string, newSource: string) => Promise<void>,
  onUpgradeAllImports: (updates: { name: string; newSource: string }[]) => Promise<void>,
): ImportUpgradeState {
  const [activeName, setActiveName] = useState<string | null>(null);
  const [versions, setVersions] = useState<MarkedVersion[]>([]);
  const [noneRunnable, setNoneRunnable] = useState<IncompatibilityReason | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  // Monotonic token: only the most recent loadVersions call may paint results,
  // so a slow fetch for a previously-opened menu can't overwrite a newer one.
  const requestId = useRef(0);

  const dismissNotices = useCallback(() => {
    setSubmitError(null);
    setPinNotice(null);
  }, []);

  const loadVersions = useCallback(
    async (imp: ParsedImport) => {
      const ref = parseVersionedRef(imp.source);
      if (!ref) return;

      const id = ++requestId.current;
      setActiveName(imp.name);
      setVersions([]);
      setNoneRunnable(null);
      setError(null);
      setLoading(true);

      try {
        // Kept whole rather than mapped to names: the dropdown renders the
        // version, and picking one writes the pin that came with it.
        const result = await listVersions(ref.baseRef);
        // Every entry is asked, not just the newest: this list is a deliberate
        // pick, so the rows nothing would auto-select still have to be marked.
        // The answers are memoized per version, so a second open costs nothing.
        const marked = await markVersionCompatibility(ref.baseRef, result, isCompatible);
        if (requestId.current !== id) return;
        setVersions(marked);
        setNoneRunnable(noneRunnableReason(marked));
        if (result.length === 0) setError("Not tracked by the hub");
      } catch (err) {
        if (requestId.current !== id) return;
        setError(errText(err));
      } finally {
        if (requestId.current === id) setLoading(false);
      }
    },
    [listVersions, isCompatible],
  );

  // Both apply paths share one wrapper so neither can lose an error: the
  // dropdown and the Upgrade button used to differ, and "Upgrade all" had no
  // rejection handling at all.
  const applyUpgrade = useCallback(
    async (run: () => Promise<void>, unpinnedCount: number) => {
      setSubmitError(null);
      setPinNotice(null);
      setSubmitting(true);
      try {
        await run();
        if (unpinnedCount > 0) setPinNotice(pinDroppedMessage(unpinnedCount));
      } catch (err) {
        setSubmitError(errText(err));
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  const selectVersion = useCallback(
    async (imp: ParsedImport, version: ModuleVersion) => {
      if (!parseVersionedRef(imp.source)) {
        // Unreachable from the UI (a row without a parseable version renders no
        // upgrade control), but `withRefVersion` would throw rather than invent
        // a ref, so refuse here with something the user can act on.
        setSubmitError(`'${imp.source}' names no version to upgrade.`);
        return;
      }
      await applyUpgrade(
        () => onUpgradeImport(imp.name, upgradedImportSource(imp, version)),
        isImportPinned(imp) && version.integrity == null ? 1 : 0,
      );
    },
    [applyUpgrade, onUpgradeImport],
  );

  const upgradeAll = useCallback(
    async (updates: BulkUpgrade[]) => {
      if (updates.length === 0) return;
      await applyUpgrade(
        () => onUpgradeAllImports(updates.map(({ name, newSource }) => ({ name, newSource }))),
        updates.filter((u) => u.wasPinned && !u.repinned).length,
      );
    },
    [applyUpgrade, onUpgradeAllImports],
  );

  return {
    activeName,
    versions,
    noneRunnable,
    loading,
    error,
    submitting,
    submitError,
    pinNotice,
    dismissNotices,
    loadVersions,
    selectVersion,
    upgradeAll,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

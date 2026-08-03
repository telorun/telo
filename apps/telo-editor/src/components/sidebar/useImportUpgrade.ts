import { parseVersionedRef, withRefVersion } from "@telorun/analyzer";
import { useCallback, useRef, useState } from "react";
import { fetchHubVersions } from "../../hub-search";
import type { ParsedImport } from "../../model";

export interface ImportUpgradeState {
  /** Name of the import whose versions are currently loaded, or null. */
  activeName: string | null;
  /** Versions for that import, newest first (the hub's ordering). */
  versions: string[];
  loading: boolean;
  /** Why the version list could not be loaded. Rendered inside the dropdown
   *  that asked for it. */
  error: string | null;
  submitting: boolean;
  /** Why the last upgrade attempt failed. Rendered as a view-level banner: an
   *  upgrade can be applied from the button without ever opening a dropdown, so
   *  it must not depend on a menu being on screen to be seen. */
  submitError: string | null;
  /** Set after an applied upgrade that removed an inline integrity pin, so the
   *  view can say so — the rewrite is otherwise invisible in the YAML. */
  pinNotice: string | null;
  dismissNotices(): void;
  /** Fetch the available versions for an import (called when its menu opens). */
  loadVersions(imp: ParsedImport): Promise<void>;
  /** Re-point one import at `version`. */
  selectVersion(imp: ParsedImport, version: string): Promise<void>;
  /** Re-point many imports in one persist cycle ("Upgrade all"). */
  upgradeAll(updates: BulkUpgrade[]): Promise<void>;
}

/** One entry of an "Upgrade all" batch. `wasPinned` is the caller's reading of
 *  the import it replaces, so the batch can report how many pins it dropped. */
export interface BulkUpgrade {
  name: string;
  newSource: string;
  wasPinned: boolean;
}

/** The number of upgraded imports that carried a pin, phrased for the banner. */
function pinRemovedMessage(count: number): string {
  return (
    `Removed the integrity pin from ${count} upgraded import${count === 1 ? "" : "s"} — ` +
    `the hash covers the version that was replaced, and it cannot be recomputed here. ` +
    `Run \`telo upgrade\` to re-pin.`
  );
}

export function useImportUpgrade(
  hubUrl: string | undefined,
  onUpgradeImport: (name: string, newSource: string) => Promise<void>,
  onUpgradeAllImports: (updates: { name: string; newSource: string }[]) => Promise<void>,
): ImportUpgradeState {
  const [activeName, setActiveName] = useState<string | null>(null);
  const [versions, setVersions] = useState<string[]>([]);
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
      setError(null);
      setLoading(true);

      try {
        // The dropdown offers version names; the pin each entry carries is for
        // the upgrade path, which this view does not write yet.
        const result = await fetchHubVersions(hubUrl, ref.baseRef);
        if (requestId.current !== id) return;
        setVersions(result.map((v) => v.version));
        if (result.length === 0) setError("Not tracked by the hub");
      } catch (err) {
        if (requestId.current !== id) return;
        setError(errText(err));
      } finally {
        if (requestId.current === id) setLoading(false);
      }
    },
    [hubUrl],
  );

  // Both apply paths share one wrapper so neither can lose an error: the
  // dropdown and the Upgrade button used to differ, and "Upgrade all" had no
  // rejection handling at all.
  const applyUpgrade = useCallback(
    async (run: () => Promise<void>, pinnedCount: number) => {
      setSubmitError(null);
      setPinNotice(null);
      setSubmitting(true);
      try {
        await run();
        if (pinnedCount > 0) setPinNotice(pinRemovedMessage(pinnedCount));
      } catch (err) {
        setSubmitError(errText(err));
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  const selectVersion = useCallback(
    async (imp: ParsedImport, version: string) => {
      const ref = parseVersionedRef(imp.source);
      if (!ref) {
        // Unreachable from the UI (a row without a parseable version renders no
        // upgrade control), but `withRefVersion` would throw rather than invent
        // a ref, so refuse here with something the user can act on.
        setSubmitError(`'${imp.source}' names no version to upgrade.`);
        return;
      }
      // Re-points the ref at `version` and drops any inline `#sha256-…` pin —
      // the pin hashes the module's `telo.yaml`, which a browser cannot compute
      // for every transport. `telo upgrade` re-pins the rewritten import.
      const newSource = withRefVersion(imp.source, version);
      await applyUpgrade(
        () => onUpgradeImport(imp.name, newSource),
        ref.integrity != null ? 1 : 0,
      );
    },
    [applyUpgrade, onUpgradeImport],
  );

  const upgradeAll = useCallback(
    async (updates: BulkUpgrade[]) => {
      if (updates.length === 0) return;
      await applyUpgrade(
        () => onUpgradeAllImports(updates.map(({ name, newSource }) => ({ name, newSource }))),
        updates.filter((u) => u.wasPinned).length,
      );
    },
    [applyUpgrade, onUpgradeAllImports],
  );

  return {
    activeName,
    versions,
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

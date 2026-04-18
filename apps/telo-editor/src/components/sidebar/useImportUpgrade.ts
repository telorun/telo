import { useCallback, useEffect, useState } from "react";
import { fetchAvailableVersions, parseRegistryRef } from "../../loader";
import type { RegistryVersion } from "../../loader";
import type { ParsedImport, RegistryServer } from "../../model";

export interface ImportUpgradeState {
  /** Name of the import whose upgrade dropdown is currently open, or null. */
  upgradingName: string | null;
  versions: RegistryVersion[];
  loading: boolean;
  error: string | null;
  submitting: boolean;
  /** Open the dropdown for an import; closes again if already open. */
  toggle(imp: ParsedImport): Promise<void>;
  /** Apply a version selection — calls the parent handler, closes on success. */
  selectVersion(imp: ParsedImport, version: string): Promise<void>;
  cancel(): void;
}

export function useImportUpgrade(
  registryServers: RegistryServer[],
  onUpgradeImport: (name: string, newSource: string) => Promise<void>,
): ImportUpgradeState {
  const [upgradingName, setUpgradingName] = useState<string | null>(null);
  const [versions, setVersions] = useState<RegistryVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const cancel = useCallback(() => {
    setUpgradingName(null);
    setVersions([]);
    setError(null);
  }, []);

  const toggle = useCallback(
    async (imp: ParsedImport) => {
      if (upgradingName === imp.name) {
        cancel();
        return;
      }
      const ref = parseRegistryRef(imp.source);
      if (!ref) return;

      setUpgradingName(imp.name);
      setVersions([]);
      setError(null);
      setLoading(true);

      try {
        const result = await fetchAvailableVersions(ref.moduleId, registryServers);
        setVersions(result);
        if (result.length === 0) setError("No versions available");
      } catch {
        setError("Failed to fetch versions");
      } finally {
        setLoading(false);
      }
    },
    [upgradingName, registryServers, cancel],
  );

  const selectVersion = useCallback(
    async (imp: ParsedImport, version: string) => {
      const ref = parseRegistryRef(imp.source);
      if (!ref) return;
      const newSource = `${ref.moduleId}@${version}`;
      setSubmitting(true);
      try {
        await onUpgradeImport(imp.name, newSource);
        setUpgradingName(null);
        setVersions([]);
      } catch {
        setError("Upgrade failed");
      } finally {
        setSubmitting(false);
      }
    },
    [onUpgradeImport],
  );

  // Dismiss the dropdown on outside click. Clicks inside elements tagged with
  // `data-upgrade-dropdown` are treated as in-dropdown and don't dismiss.
  useEffect(() => {
    if (!upgradingName) return;
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-upgrade-dropdown]")) {
        setUpgradingName(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [upgradingName]);

  return { upgradingName, versions, loading, error, submitting, toggle, selectVersion, cancel };
}

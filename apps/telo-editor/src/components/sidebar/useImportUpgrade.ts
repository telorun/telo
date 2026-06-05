import { useCallback, useRef, useState } from "react";
import { fetchAvailableVersions, parseRegistryRef } from "../../loader";
import type { RegistryVersion } from "../../loader";
import type { ParsedImport, RegistryServer } from "../../model";

export interface ImportUpgradeState {
  /** Name of the import whose versions are currently loaded, or null. */
  activeName: string | null;
  versions: RegistryVersion[];
  loading: boolean;
  error: string | null;
  submitting: boolean;
  /** Fetch the available versions for an import (called when its menu opens). */
  loadVersions(imp: ParsedImport): Promise<void>;
  /** Apply a version selection — calls the parent handler. */
  selectVersion(imp: ParsedImport, version: string): Promise<void>;
}

export function useImportUpgrade(
  registryServers: RegistryServer[],
  onUpgradeImport: (name: string, newSource: string) => Promise<void>,
): ImportUpgradeState {
  const [activeName, setActiveName] = useState<string | null>(null);
  const [versions, setVersions] = useState<RegistryVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Monotonic token: only the most recent loadVersions call may paint results,
  // so a slow fetch for a previously-opened menu can't overwrite a newer one.
  const requestId = useRef(0);

  const loadVersions = useCallback(
    async (imp: ParsedImport) => {
      const ref = parseRegistryRef(imp.source);
      if (!ref) return;

      const id = ++requestId.current;
      setActiveName(imp.name);
      setVersions([]);
      setError(null);
      setLoading(true);

      try {
        const result = await fetchAvailableVersions(ref.moduleId, registryServers);
        if (requestId.current !== id) return;
        setVersions(result);
        if (result.length === 0) setError("No versions available");
      } catch {
        if (requestId.current !== id) return;
        setError("Failed to fetch versions");
      } finally {
        if (requestId.current === id) setLoading(false);
      }
    },
    [registryServers],
  );

  const selectVersion = useCallback(
    async (imp: ParsedImport, version: string) => {
      const ref = parseRegistryRef(imp.source);
      if (!ref) return;
      const newSource = `${ref.moduleId}@${version}`;
      setSubmitting(true);
      try {
        await onUpgradeImport(imp.name, newSource);
      } catch {
        setError("Upgrade failed");
      } finally {
        setSubmitting(false);
      }
    },
    [onUpgradeImport],
  );

  return { activeName, versions, loading, error, submitting, loadVersions, selectVersion };
}

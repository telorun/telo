import type { ModuleVersionLookup, VersionCompatibilityCheck } from "@telorun/ide-support";
import { useEffect, useState } from "react";
import { isWorkspaceModule } from "../../loader";
import type { Workspace } from "../../model";
import { isImportPinned, upgradedImportSource } from "./import-pin";
import type { BulkUpgrade } from "./useImportUpgrade";
import { resolveUpgradeTarget, type ImportLookupFailure } from "./useUpgradeTargets";

export interface WorkspaceImportUpgrades {
  /** The upgrades available across the workspace's own modules, keyed by the
   *  module's file. Only imports with a hostable newer version appear, the same
   *  rule the module bar's "Upgrade all" applies to one module. */
  outdated: Map<string, BulkUpgrade[]>;
  /** Imports the hub could not answer for, so they are not counted in
   *  `outdated`. Reported to the author, never dropped. */
  failures: ImportLookupFailure[];
}

export function useWorkspaceImportUpgrades(
  workspace: Workspace | null,
  listVersions: ModuleVersionLookup,
  isCompatible: VersionCompatibilityCheck,
): WorkspaceImportUpgrades {
  const [outdated, setOutdated] = useState<Map<string, BulkUpgrade[]>>(new Map());
  const [failures, setFailures] = useState<ImportLookupFailure[]>([]);

  const entries = workspace
    ? [...workspace.modules]
        .filter(([filePath]) => isWorkspaceModule(workspace, filePath))
        .flatMap(([filePath, manifest]) =>
          manifest.imports.map((imp) => ({ filePath, imp })),
        )
    : [];

  // Derived from what the answer depends on — each import's name, source and
  // pin — so an upgrade that rewrites them re-reads the workspace, and nothing
  // else does. JSON-encoded for the same reason as the single-module hook.
  const key = JSON.stringify(
    entries.map(({ filePath, imp }) => [filePath, imp.name, imp.source, imp.integrity ?? null]),
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      entries.map(async ({ filePath, imp }): Promise<LookupResult> => {
        try {
          const target = await resolveUpgradeTarget(imp.source, listVersions, isCompatible);
          if (!target?.best) return { kind: "none" };
          return {
            kind: "upgrade",
            filePath,
            upgrade: {
              name: imp.name,
              newSource: upgradedImportSource(imp, target.best),
              wasPinned: isImportPinned(imp),
              repinned: target.best.integrity != null,
            },
          };
        } catch (err) {
          return { kind: "failure", failure: { source: imp.source, reason: errText(err) } };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const next = new Map<string, BulkUpgrade[]>();
      const lookupFailures: ImportLookupFailure[] = [];
      for (const result of results) {
        if (result.kind === "failure") {
          lookupFailures.push(result.failure);
        } else if (result.kind === "upgrade") {
          next.set(result.filePath, [...(next.get(result.filePath) ?? []), result.upgrade]);
        }
      }
      setOutdated(next);
      setFailures(lookupFailures);
    });
    return () => {
      cancelled = true;
    };
    // `entries` is derived from `key`.
  }, [key, listVersions, isCompatible]);

  return { outdated, failures };
}

type LookupResult =
  | { kind: "none" }
  | { kind: "upgrade"; filePath: string; upgrade: BulkUpgrade }
  | { kind: "failure"; failure: ImportLookupFailure };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

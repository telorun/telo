import { useState } from "react";
import { parseRegistryRef } from "../../../loader";
import { getModuleFiles, summarizeResource } from "../../../diagnostics-aggregate";
import type { ParsedImport } from "../../../model";
import { DiagnosticBadge } from "../../diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "../../diagnostics/DiagnosticsContext";
import { AddImportForm } from "../../sidebar/AddImportForm";
import type { ImportUpgradeState } from "../../sidebar/useImportUpgrade";
import { useImportUpgrade } from "../../sidebar/useImportUpgrade";
import { Button } from "../../ui/button";
import type { ViewProps } from "../types";

/** Module-view tab for managing the active module's imports. Combines the rich
 *  read-out the Inventory tab used to show (alias / source / type / resolved
 *  path) with the add / remove / upgrade actions the sidebar used to host. */
export function ImportsView({
  viewData,
  registryServers,
  onAddImport,
  onRemoveImport,
  onUpgradeImport,
}: ViewProps) {
  const [adding, setAdding] = useState(false);
  const upgrade = useImportUpgrade(registryServers, onUpgradeImport);
  const manifest = viewData.manifest;
  const imports = manifest.imports;
  const filePaths = getModuleFiles(manifest);

  async function handleSubmit(source: string, alias: string) {
    await onAddImport(source, alias);
    setAdding(false);
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          Imports
        </h3>
        <Button size="xs" onClick={() => setAdding(true)} disabled={adding}>
          Add import
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-2">
        {adding && (
          <div className="mb-3">
            <AddImportForm
              registryServers={registryServers}
              onSubmit={handleSubmit}
              onCancel={() => setAdding(false)}
            />
          </div>
        )}

        {imports.length === 0 ? (
          !adding && (
            <div className="flex h-full items-center justify-center">
              <span className="text-sm text-zinc-400 dark:text-zinc-600">No imports</span>
            </div>
          )
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                <th className="w-5 pb-1.5" />
                <th className="pb-1.5 pr-3 font-medium">Alias</th>
                <th className="pb-1.5 pr-3 font-medium">Source</th>
                <th className="pb-1.5 pr-3 font-medium">Type</th>
                <th className="pb-1.5 pr-3 font-medium">Resolved Path</th>
                <th className="w-16 pb-1.5" />
              </tr>
            </thead>
            <tbody>
              {imports.map((imp) => (
                <ImportTableRow
                  key={imp.name}
                  imp={imp}
                  filePaths={filePaths}
                  upgrade={upgrade}
                  onRemove={onRemoveImport}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface ImportTableRowProps {
  imp: ParsedImport;
  filePaths: string[];
  upgrade: ImportUpgradeState;
  onRemove: (name: string) => void;
}

function ImportTableRow({ imp, filePaths, upgrade, onRemove }: ImportTableRowProps) {
  const ref = imp.importKind === "registry" ? parseRegistryRef(imp.source) : null;
  const isUpgrading = upgrade.upgradingName === imp.name;
  const diagState = useDiagnosticsState();
  const summary = summarizeResource(diagState, filePaths, imp.name);

  return (
    <tr className="border-b border-zinc-100 text-zinc-700 dark:border-zinc-800/50 dark:text-zinc-300">
      <td className="w-5 py-1.5 text-center">
        <DiagnosticBadge summary={summary} size="sm" showCount={false} />
      </td>
      <td className="py-1.5 pr-3 text-xs font-medium">{imp.name}</td>
      <td className="max-w-64 truncate py-1.5 pr-3 text-xs">{imp.source}</td>
      <td className="py-1.5 pr-3 text-xs">{imp.importKind}</td>
      <td className="max-w-64 truncate py-1.5 pr-3 text-xs text-zinc-400 dark:text-zinc-500">
        {imp.resolvedPath ?? "—"}
      </td>
      <td className="py-1.5">
        <div className="relative flex items-center justify-end gap-0.5">
          {ref && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => {
                e.stopPropagation();
                upgrade.toggle(imp);
              }}
              disabled={upgrade.submitting}
              data-upgrade-dropdown
              title={`Upgrade ${imp.name} (${ref.version})`}
            >
              ↑
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-zinc-400 hover:text-red-500 dark:hover:text-red-400"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(imp.name);
            }}
            title={`Remove ${imp.name}`}
          >
            ×
          </Button>

          {isUpgrading && (
            <div
              data-upgrade-dropdown
              className="absolute right-0 top-full z-10 mt-0.5 max-h-48 min-w-32 overflow-y-auto rounded border border-zinc-200 bg-white shadow-md dark:border-zinc-700 dark:bg-zinc-900"
            >
              {upgrade.loading && (
                <div className="px-3 py-2 text-xs text-zinc-400">Loading versions…</div>
              )}
              {upgrade.error && (
                <div className="px-3 py-2 text-xs text-red-500 dark:text-red-400">
                  {upgrade.error}
                </div>
              )}
              {!upgrade.loading &&
                upgrade.versions.map((v) => (
                  <button
                    key={v.version}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      upgrade.selectVersion(imp, v.version);
                    }}
                    disabled={upgrade.submitting}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800 ${
                      ref && v.version === ref.version
                        ? "font-medium text-zinc-900 dark:text-zinc-100"
                        : "text-zinc-600 dark:text-zinc-400"
                    }`}
                  >
                    <span>{v.version}</span>
                    {ref && v.version === ref.version && (
                      <span className="text-[10px] text-zinc-400">current</span>
                    )}
                  </button>
                ))}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

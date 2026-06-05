import { ArrowUp, ChevronDown, X } from "lucide-react";
import { useState } from "react";
import { parseRegistryRef } from "../../../loader";
import { getModuleFiles, summarizeResource } from "../../../diagnostics-aggregate";
import type { ParsedImport } from "../../../model";
import { DiagnosticBadge } from "../../diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "../../diagnostics/DiagnosticsContext";
import { AddImportForm } from "../../sidebar/AddImportForm";
import type { ImportUpgradeState } from "../../sidebar/useImportUpgrade";
import { useImportUpgrade } from "../../sidebar/useImportUpgrade";
import { useLatestVersions } from "../../sidebar/useLatestVersions";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
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
  onUpgradeAllImports,
}: ViewProps) {
  const [adding, setAdding] = useState(false);
  const [upgradingAll, setUpgradingAll] = useState(false);
  const upgrade = useImportUpgrade(registryServers, onUpgradeImport);
  const manifest = viewData.manifest;
  const imports = manifest.imports;
  const filePaths = getModuleFiles(manifest);
  const latestVersions = useLatestVersions(imports, registryServers);

  const outdated = imports.flatMap((imp) => {
    const ref = imp.importKind === "registry" ? parseRegistryRef(imp.source) : null;
    if (!ref) return [];
    const latest = latestVersions.get(ref.moduleId);
    if (!latest || latest === ref.version) return [];
    return [{ name: imp.name, newSource: `${ref.moduleId}@${latest}` }];
  });

  async function handleSubmit(source: string, alias: string) {
    await onAddImport(source, alias);
    setAdding(false);
  }

  async function handleUpgradeAll() {
    setUpgradingAll(true);
    try {
      await onUpgradeAllImports(outdated);
    } finally {
      setUpgradingAll(false);
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          Imports
        </h3>
        <div className="flex items-center gap-2">
          {outdated.length > 0 && (
            <Button
              size="xs"
              variant="outline"
              className="text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
              onClick={handleUpgradeAll}
              disabled={upgradingAll}
            >
              <ArrowUp />
              {upgradingAll ? "Upgrading…" : `Upgrade all (${outdated.length})`}
            </Button>
          )}
          <Button size="xs" onClick={() => setAdding(true)} disabled={adding}>
            Add import
          </Button>
        </div>
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
                  latestVersions={latestVersions}
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
  latestVersions: Map<string, string>;
  onRemove: (name: string) => void;
}

function ImportTableRow({ imp, filePaths, upgrade, latestVersions, onRemove }: ImportTableRowProps) {
  const ref = imp.importKind === "registry" ? parseRegistryRef(imp.source) : null;
  const latest = ref ? latestVersions.get(ref.moduleId) : undefined;
  const outdated = ref != null && latest != null && latest !== ref.version;
  const diagState = useDiagnosticsState();
  const summary = summarizeResource(diagState, filePaths, imp.name);

  const versionMenu = ref && (
    <DropdownMenuContent align="end" className="max-h-64 w-44 overflow-y-auto">
      <DropdownMenuLabel>Versions</DropdownMenuLabel>
      {upgrade.activeName === imp.name && upgrade.loading && (
        <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
      )}
      {upgrade.activeName === imp.name && upgrade.error && (
        <DropdownMenuItem disabled>{upgrade.error}</DropdownMenuItem>
      )}
      {upgrade.activeName === imp.name &&
        !upgrade.loading &&
        upgrade.versions.map((v) => (
          <DropdownMenuItem
            key={v.version}
            onSelect={() => upgrade.selectVersion(imp, v.version)}
            disabled={upgrade.submitting}
            className="justify-between gap-3"
          >
            <span className="tabular-nums">{v.version}</span>
            {v.version === ref.version && (
              <span className="text-[10px] text-muted-foreground">current</span>
            )}
          </DropdownMenuItem>
        ))}
    </DropdownMenuContent>
  );

  return (
    <tr className="border-b border-zinc-100 text-zinc-700 dark:border-zinc-800/50 dark:text-zinc-300">
      <td className="w-5 py-1.5 text-center">
        <DiagnosticBadge summary={summary} size="sm" showCount={false} />
      </td>
      <td className="py-1.5 pr-3 text-xs font-medium">{imp.name}</td>
      <td className="max-w-64 py-1.5 pr-3 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="truncate">{imp.source}</span>
          {outdated && (
            <Badge
              variant="outline"
              className="shrink-0 border-amber-500/40 text-amber-600 dark:text-amber-400"
              title={`Latest is ${latest}`}
            >
              Outdated
            </Badge>
          )}
        </div>
      </td>
      <td className="py-1.5 pr-3 text-xs">{imp.importKind}</td>
      <td className="max-w-64 truncate py-1.5 pr-3 text-xs text-zinc-400 dark:text-zinc-500">
        {imp.resolvedPath ?? "—"}
      </td>
      <td className="py-1.5">
        <div className="flex items-center justify-end gap-1">
          {ref && outdated && (
            <div className="flex items-stretch">
              <Button
                variant="outline"
                size="xs"
                className="rounded-r-none text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
                onClick={() => latest && upgrade.selectVersion(imp, latest)}
                disabled={upgrade.submitting}
                title={`Upgrade ${imp.name} to ${latest}`}
              >
                <ArrowUp />
                Upgrade
              </Button>
              <DropdownMenu onOpenChange={(open) => open && upgrade.loadVersions(imp)}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-xs"
                    className="rounded-l-none border-l border-l-black/15 dark:border-l-white/15"
                    disabled={upgrade.submitting}
                    aria-label={`Choose a version for ${imp.name}`}
                    title={`Choose a version for ${imp.name}`}
                  >
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                {versionMenu}
              </DropdownMenu>
            </div>
          )}
          {ref && !outdated && (
            <DropdownMenu onOpenChange={(open) => open && upgrade.loadVersions(imp)}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={upgrade.submitting}
                  aria-label={`Choose a version for ${imp.name}`}
                  title={`Choose a version for ${imp.name} (current ${ref.version})`}
                >
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              {versionMenu}
            </DropdownMenu>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-zinc-400 hover:text-red-500 dark:hover:text-red-400"
            onClick={() => onRemove(imp.name)}
            aria-label={`Remove ${imp.name}`}
            title={`Remove ${imp.name}`}
          >
            <X />
          </Button>
        </div>
      </td>
    </tr>
  );
}

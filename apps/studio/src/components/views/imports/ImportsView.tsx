import { isSameModuleVersion, parseVersionedRef } from "@telorun/analyzer";
import {
  describeReason,
  describeRemedy,
  type IncompatibilityReason,
} from "@telorun/ide-support";
import { ArrowUp, ChevronDown, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { getModuleFiles, summarizeResource } from "../../../diagnostics-aggregate";
import type { ParsedImport } from "../../../model";
import { DiagnosticBadge } from "../../diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "../../diagnostics/DiagnosticsContext";
import { AddImportDialog } from "../../AddImportDialog";
import { isImportPinned, upgradedImportSource } from "../../sidebar/import-pin";
import type { ImportUpgradeState } from "../../sidebar/useImportUpgrade";
import { useImportUpgrade } from "../../sidebar/useImportUpgrade";
import { useModuleVersions } from "../../sidebar/useModuleVersions";
import { useUpgradeTargets, type UpgradeTarget } from "../../sidebar/useUpgradeTargets";
import { useVersionCompatibility } from "../../sidebar/useVersionCompatibility";
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
  hubUrl,
  manifestCacheUrl,
  onAddImport,
  importableLibraries,
  onRemoveImport,
  onUpgradeImport,
  onUpgradeAllImports,
  onOpenModule,
}: ViewProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  // One version lookup and one compatibility check for the whole view: the
  // badge, the upgrade button, the version picker and the add dialog all ask
  // about the same modules and the same versions, so they ask once.
  const listVersions = useModuleVersions(hubUrl);
  const isCompatible = useVersionCompatibility(manifestCacheUrl);
  const upgrade = useImportUpgrade(
    listVersions,
    isCompatible,
    onUpgradeImport,
    onUpgradeAllImports,
  );
  const manifest = viewData.manifest;
  const imports = manifest.imports;
  const filePaths = getModuleFiles(manifest);
  const targets = useUpgradeTargets(imports, listVersions, isCompatible);

  // Only versions this telo can host are offered — "Upgrade all" must not walk
  // the author into a manifest their runtime refuses to load.
  const outdated = imports.flatMap((imp) => {
    const best = targets.get(imp.name)?.best;
    if (!best) return [];
    return [
      {
        name: imp.name,
        newSource: upgradedImportSource(imp, best),
        wasPinned: isImportPinned(imp),
        repinned: best.integrity != null,
      },
    ];
  });

  // Imports that ARE behind but have nothing hostable to move to. Reported at
  // the top of the view: the per-row control can only say "not offered", and
  // the action — update telo — is the same for all of them.
  const blocked = imports.flatMap((imp) => {
    const target = targets.get(imp.name);
    return target && !target.best && target.heldBack
      ? [{ name: imp.name, ...target.heldBack }]
      : [];
  });

  async function handleImportLibrary(source: string, alias: string) {
    setImportError(null);
    try {
      await onAddImport(source, alias);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
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
              onClick={() => upgrade.upgradeAll(outdated)}
              disabled={upgrade.submitting}
            >
              <ArrowUp />
              {upgrade.submitting ? "Upgrading…" : `Upgrade all (${outdated.length})`}
            </Button>
          )}
          {importableLibraries.length > 0 ? (
            <div className="flex items-stretch">
              <Button size="xs" className="rounded-r-none" onClick={() => setAddOpen(true)}>
                Add import
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-xs"
                    className="rounded-l-none border-l border-l-black/15 dark:border-l-white/15"
                    aria-label="Import a workspace library"
                    title="Import a workspace library"
                  >
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-64 w-56 overflow-y-auto">
                  <DropdownMenuLabel>Import library</DropdownMenuLabel>
                  {importableLibraries.map((lib) => (
                    <DropdownMenuItem
                      key={lib.filePath}
                      onSelect={() => void handleImportLibrary(lib.source, lib.alias)}
                      className="flex-col items-start gap-0"
                    >
                      <span className="text-xs font-medium">{lib.name}</span>
                      <span className="text-[10px] text-muted-foreground">{lib.source}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            <Button size="xs" onClick={() => setAddOpen(true)}>
              Add import
            </Button>
          )}
        </div>
      </div>

      {importError && (
        <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400">
          Couldn&apos;t add import: {importError}
        </div>
      )}

      {upgrade.submitError && (
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-red-300 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          <span>Upgrade failed: {upgrade.submitError}</span>
          <button type="button" onClick={upgrade.dismissNotices} aria-label="Dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {blocked.length > 0 && (
        <div className="flex shrink-0 items-start gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{blockedMessage(blocked)}</span>
        </div>
      )}

      {upgrade.pinNotice && (
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400">
          <span>{upgrade.pinNotice}</span>
          <button type="button" onClick={upgrade.dismissNotices} aria-label="Dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <AddImportDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        hubUrl={hubUrl}
        listVersions={listVersions}
        isCompatible={isCompatible}
        libraries={importableLibraries}
        existingAliases={imports.map((imp) => imp.name)}
        onSubmit={onAddImport}
      />

      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-2">
        {imports.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <span className="text-sm text-zinc-400 dark:text-zinc-600">No imports</span>
          </div>
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
                  target={targets.get(imp.name)}
                  onRemove={onRemoveImport}
                  onOpenModule={onOpenModule}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** The banner for imports that are behind with nothing offerable.
 *
 *  A remedy is only stated when every entry shares one cause. A mixed set has
 *  two different answers — update telo for one, wait for a republish for the
 *  other — and printing the first entry's would be wrong for the rest, which is
 *  the same invented-cause mistake the four verdicts exist to prevent. */
function blockedMessage(
  blocked: Array<{ name: string; version: string; reason: IncompatibilityReason }>,
): string {
  const uniform = blocked.every((b) => b.reason === blocked[0].reason) ? blocked[0].reason : null;
  const head =
    blocked.length === 1
      ? `A newer version of ${blocked[0].name} (${blocked[0].version}) is published, but ${describeReason(blocked[0].reason)}.`
      : `Newer versions of ${blocked.map((b) => b.name).join(", ")} are published that this telo cannot use.`;
  return uniform
    ? `${head} ${describeRemedy(uniform)}`
    : `${head} Hover each import for what is holding it back.`;
}

/** The "Outdated" badge's tooltip. A reason is only ever printed when one was
 *  established: the three states are "behind and upgradeable", "behind, with a
 *  newer version held back", and "behind with nothing offerable", and the last
 *  two are exactly the ones that carry a cause. */
function outdatedTitle(
  newest: string | null | undefined,
  offering: string | undefined,
  heldBack: { version: string; reason: IncompatibilityReason } | null,
): string {
  if (!heldBack) return `Latest is ${newest}`;
  const cause = `${heldBack.version} held back because ${describeReason(heldBack.reason)}`;
  return offering ? `${cause} — offering ${offering}` : cause;
}

interface ImportTableRowProps {
  imp: ParsedImport;
  filePaths: string[];
  upgrade: ImportUpgradeState;
  /** What an upgrade would do to this import, once resolved. Absent while the
   *  lookup is in flight, or when the ref names no version to upgrade. */
  target: UpgradeTarget | undefined;
  onRemove: (name: string) => void;
  onOpenModule: (filePath: string) => void;
}

function ImportTableRow({
  imp,
  filePaths,
  upgrade,
  target,
  onRemove,
  onOpenModule,
}: ImportTableRowProps) {
  const ref = parseVersionedRef(imp.source);
  const best = target?.best ?? null;
  const heldBack = target?.heldBack ?? null;
  // "Behind" is about what is published; whether anything can be offered is a
  // separate question, and conflating them would hide a newer version that
  // exists.
  const outdated = target?.newest != null;
  const diagState = useDiagnosticsState();
  const summary = summarizeResource(diagState, filePaths, imp.name);

  const versionMenu = ref && (
    <DropdownMenuContent align="end" className="max-h-64 w-56 overflow-y-auto">
      <DropdownMenuLabel>Versions</DropdownMenuLabel>
      {upgrade.activeName === imp.name && upgrade.loading && (
        <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
      )}
      {upgrade.activeName === imp.name && upgrade.error && (
        <DropdownMenuItem disabled className="whitespace-normal text-[11px] leading-snug">
          {upgrade.error}
        </DropdownMenuItem>
      )}
      {/* A list where every row is marked explains nothing on its own. */}
      {upgrade.activeName === imp.name && !upgrade.loading && upgrade.noneRunnable && (
        <DropdownMenuItem disabled className="whitespace-normal text-[11px] leading-snug">
          {upgrade.noneRunnable === "unreadable"
            ? "No published version can be checked — their declared requirements cannot be read."
            : "No published version runs on this telo."}{" "}
          {describeRemedy(upgrade.noneRunnable)}
        </DropdownMenuItem>
      )}
      {upgrade.activeName === imp.name &&
        !upgrade.loading &&
        upgrade.versions.map((version) => (
          <DropdownMenuItem
            key={version.version}
            onSelect={() => upgrade.selectVersion(imp, version)}
            disabled={upgrade.submitting}
            className="justify-between gap-3"
            title={
              version.compatibility === "too-new"
                ? `${version.version} requires a newer telo than this one`
                : version.compatibility === "unreadable"
                  ? `${version.version} declares a requirement that cannot be read`
                  : undefined
            }
          >
            <span className="tabular-nums">{version.version}</span>
            {isSameModuleVersion(version.version, ref.version) ? (
              <span className="text-[10px] text-muted-foreground">current</span>
            ) : version.compatibility === "too-new" ? (
              // Listed, not hidden: a picker is a deliberate choice, and an
              // author may knowingly pin a version for a telo they will have.
              <span className="text-[10px] text-amber-600 dark:text-amber-400">needs newer telo</span>
            ) : version.compatibility === "unreadable" ? (
              <span className="text-[10px] text-amber-600 dark:text-amber-400">unreadable</span>
            ) : null}
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
              title={outdatedTitle(target?.newest, best?.version, heldBack)}
            >
              Outdated
            </Badge>
          )}
        </div>
      </td>
      <td className="py-1.5 pr-3 text-xs">{imp.importKind}</td>
      <td className="max-w-64 py-1.5 pr-3 text-xs">
        {imp.loadError ? (
          // The workspace opened without this dependency. Saying so here is the
          // whole point — a row that just resolved to nothing left the author
          // guessing which import was missing.
          <span
            className="flex items-center gap-1 text-amber-600 dark:text-amber-400"
            title={imp.loadError}
          >
            <TriangleAlert className="size-3.5 shrink-0" />
            <span className="truncate">Unresolved</span>
          </span>
        ) : imp.resolvedPath ? (
          <button
            type="button"
            onClick={() => onOpenModule(imp.resolvedPath!)}
            className="block max-w-full truncate text-left text-blue-600 hover:underline dark:text-blue-400"
            title={`Open ${imp.resolvedPath}`}
          >
            {imp.resolvedPath}
          </button>
        ) : (
          <span className="text-zinc-400 dark:text-zinc-500">—</span>
        )}
      </td>
      <td className="py-1.5">
        <div className="flex items-center justify-end gap-1">
          {ref && best && (
            <div className="flex items-stretch">
              <Button
                variant="outline"
                size="xs"
                className="rounded-r-none text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
                onClick={() => upgrade.selectVersion(imp, best)}
                disabled={upgrade.submitting}
                title={
                  target?.heldBack
                    ? `Upgrade ${imp.name} to ${best.version} — ${target.heldBack.version} is newer but ${describeReason(target.heldBack.reason)}`
                    : `Upgrade ${imp.name} to ${best.version}`
                }
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
          {ref && !best && (
            <DropdownMenu onOpenChange={(open) => open && upgrade.loadVersions(imp)}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={upgrade.submitting}
                  aria-label={`Choose a version for ${imp.name}`}
                  title={
                    // A version exists that nothing here can offer: say so on
                    // the only control this row still has.
                    heldBack
                      ? `${heldBack.version} is published but ${describeReason(heldBack.reason)} — choose a version for ${imp.name} (current ${ref.version})`
                      : `Choose a version for ${imp.name} (current ${ref.version})`
                  }
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

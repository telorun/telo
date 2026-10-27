import { ArrowUp } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { hasApplicationImporter, moduleSubtree } from "../../loader";
import type { ModuleKind, ParsedManifest, Workspace } from "../../model";
import { useRun } from "../../run";
import { sessionUnavailableReason } from "../../run/ui/SessionStatusChip";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import type { BulkUpgrade } from "./useImportUpgrade";
import { getModuleFiles, summarizeFiles } from "../../diagnostics-aggregate";
import { DiagnosticBadge } from "../diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "../diagnostics/DiagnosticsContext";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { buildModuleForest, flattenModules, type ModuleNode } from "./module-tree";

interface WorkspaceTreeProps {
  workspace: Workspace;
  activeModulePath: string | null;
  onOpenModule: (filePath: string) => void;
  onNewModule: (kind: ModuleKind) => void;
  onDeleteModule: (filePath: string) => Promise<void>;
  onRunModule?: (filePath: string) => void;
  importUpgrades?: ImportUpgrades;
}

export interface ImportUpgrades {
  /** The upgrades available per module file; a module absent has none. */
  outdated: Map<string, BulkUpgrade[]>;
  busy: boolean;
  onUpgrade: (filePaths: string[]) => void;
}

/** The section's upgrade: every module in it that has one, or none when no
 *  module of the section does. */
function sectionUpgrade(
  nodes: ModuleNode[],
  importUpgrades: ImportUpgrades | undefined,
): SectionUpgrade | undefined {
  if (!importUpgrades) return undefined;
  const filePaths = flattenModules(nodes).map((node) => node.manifest.filePath);
  const count = filePaths.reduce(
    (total, filePath) => total + (importUpgrades.outdated.get(filePath)?.length ?? 0),
    0,
  );
  if (count === 0) return undefined;
  return {
    count,
    busy: importUpgrades.busy,
    onUpgrade: () => importUpgrades.onUpgrade(filePaths),
  };
}

export function WorkspaceTree({
  workspace,
  activeModulePath,
  onOpenModule,
  onNewModule,
  onDeleteModule,
  onRunModule,
  importUpgrades,
}: WorkspaceTreeProps) {
  const { applications, libraries } = useMemo(() => buildModuleForest(workspace), [workspace]);
  const { session } = useRun();
  const runUnavailable = session ? sessionUnavailableReason(session) : null;
  const [deleteTarget, setDeleteTarget] = useState<ParsedManifest | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await onDeleteModule(deleteTarget.filePath);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  const deleteSubtree = deleteTarget ? moduleSubtree(workspace, deleteTarget.filePath) : [];
  const nested = deleteSubtree.filter((path) => path !== deleteTarget?.filePath);
  const subtreeSet = new Set(deleteSubtree);
  const importers = [
    ...new Set(
      deleteSubtree.flatMap((path) => [...(workspace.importedBy.get(path) ?? [])]),
    ),
  ].filter((path) => !subtreeSet.has(path));

  function renderModule(node: ModuleNode) {
    const { filePath } = node.manifest;
    return (
      <Fragment key={filePath}>
        <ModuleRow
          node={node}
          active={filePath === activeModulePath}
          workspace={workspace}
          onOpen={() => onOpenModule(filePath)}
          onDelete={() => setDeleteTarget(node.manifest)}
          onRun={
            onRunModule && node.manifest.kind === "Application"
              ? () => onRunModule(filePath)
              : undefined
          }
          runUnavailable={runUnavailable}
        />
        {node.children.length > 0 && (
          <div className="ml-5 border-l border-zinc-200 dark:border-zinc-800">
            {node.children.map(renderModule)}
          </div>
        )}
      </Fragment>
    );
  }

  return (
    <>
      <TreeSection
        label="Applications"
        addLabel="New application"
        emptyText="No applications yet"
        onAdd={() => onNewModule("Application")}
        upgrade={sectionUpgrade(applications, importUpgrades)}
      >
        {applications.map(renderModule)}
      </TreeSection>

      <div className="mx-3 border-t border-zinc-100 dark:border-zinc-800" />

      <TreeSection
        label="Libraries"
        addLabel="New library"
        emptyText="No libraries yet"
        onAdd={() => onNewModule("Library")}
        upgrade={sectionUpgrade(libraries, importUpgrades)}
      >
        {libraries.map(renderModule)}
      </TreeSection>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.metadata.name}?</DialogTitle>
            <DialogDescription>This will remove the module directory from disk.</DialogDescription>
          </DialogHeader>
          {nested.length > 0 && (
            <div className="space-y-1 text-sm">
              <p>
                {nested.length} nested module{nested.length === 1 ? "" : "s"} will be deleted with it:
              </p>
              <ul className="max-h-40 overflow-y-auto rounded border border-zinc-200 bg-zinc-50 p-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
                {nested.map((path) => (
                  <li key={path} className="truncate">
                    {workspace.modules.get(path)?.metadata.name ?? path}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {importers.length > 0 && (
            <div className="space-y-1 text-sm">
              <p>
                {importers.length} importer{importers.length === 1 ? "" : "s"} will have their
                Telo.Import entries for these modules removed:
              </p>
              <ul className="max-h-40 overflow-y-auto rounded border border-zinc-200 bg-zinc-50 p-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
                {importers.map((path) => (
                  <li key={path} className="truncate">
                    {workspace.modules.get(path)?.metadata.name ?? path}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface SectionUpgrade {
  count: number;
  busy: boolean;
  onUpgrade: () => void;
}

interface TreeSectionProps {
  label: string;
  addLabel: string;
  emptyText: string;
  onAdd: () => void;
  upgrade?: SectionUpgrade;
  children: React.ReactNode;
}

function TreeSection({
  label,
  addLabel,
  emptyText,
  onAdd,
  upgrade,
  children,
}: TreeSectionProps) {
  const childCount = Array.isArray(children) ? children.length : children ? 1 : 0;

  return (
    <div className="pb-1 pt-2">
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          {label}
        </span>
        <span className="flex items-center gap-1">
          {upgrade && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="max-md:size-9"
              onClick={upgrade.onUpgrade}
              disabled={upgrade.busy}
              title={`Upgrade ${upgrade.count} outdated ${upgrade.count === 1 ? "import" : "imports"} in ${label.toLowerCase()}`}
              aria-label={`Upgrade imports in ${label.toLowerCase()}`}
            >
              <ArrowUp className="size-3.5" />
            </Button>
          )}
          <Button
          variant="ghost"
          size="icon-xs"
          className="max-md:size-9 max-md:text-base"
          onClick={onAdd}
          title={addLabel}
        >
          +
        </Button>
        </span>
      </div>
      {childCount === 0 && (
        <div className="px-4 py-1 text-xs italic text-zinc-400 dark:text-zinc-600">
          {emptyText}
        </div>
      )}
      {children}
    </div>
  );
}

interface ModuleRowProps {
  node: ModuleNode;
  active: boolean;
  workspace: Workspace;
  onOpen: () => void;
  onDelete: () => void;
  onRun?: () => void;
  /** Why the workspace's session cannot run an application; null while it can. */
  runUnavailable?: string | null;
}

function ModuleRow({ node, active, workspace, onOpen, onDelete, onRun, runUnavailable = null }: ModuleRowProps) {
  const isLibrary = node.manifest.kind === "Library";
  const dim = isLibrary && !hasApplicationImporter(workspace, node.manifest.filePath);
  const icon = isLibrary ? "□" : "▷";
  const diagState = useDiagnosticsState();
  const summary = summarizeFiles(diagState, getModuleFiles(node.manifest));
  // A run lives in its owning Application's pane, so this dot is the only place
  // a run in a module you are not looking at is visible.
  const { liveRunForApp } = useRun();
  const liveRun = isLibrary ? null : liveRunForApp(node.manifest.filePath);

  const base =
    "flex items-center gap-1.5 px-4 py-0.5 cursor-pointer select-none group max-md:py-0 max-md:pr-1";
  const hoverOrActive = active
    ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900";

  return (
    <div className={`${base} ${hoverOrActive} ${dim ? "opacity-50" : ""}`} onClick={onOpen}>
      <span className="text-zinc-400">{icon}</span>
      <span className="min-w-0 flex-1 truncate max-md:py-2.5">{node.manifest.metadata.name}</span>
      {liveRun && (
        <span
          title={liveRun.status.kind === "running" ? "Running" : "Starting"}
          aria-label={liveRun.status.kind === "running" ? "Running" : "Starting"}
          className={`size-1.5 shrink-0 rounded-full ${
            liveRun.status.kind === "running"
              ? "bg-emerald-500"
              : "animate-pulse bg-amber-500"
          }`}
        />
      )}
      <DiagnosticBadge summary={summary} size="sm" />
      {dim && (
        <span className="shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          no importers
        </span>
      )}
      {onRun && (
        <TooltipProvider>
          <Tooltip>
            {/* A disabled button takes no pointer events, so the trigger is the span around it. */}
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="invisible text-zinc-400 group-hover:visible hover:text-emerald-600 touch:visible max-md:size-9 dark:hover:text-emerald-400"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRun();
                  }}
                  disabled={runUnavailable !== null}
                >
                  ▶
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {runUnavailable
                ? `Can't run: the workspace's session is unavailable — ${runUnavailable}`
                : "Run"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="invisible text-zinc-400 group-hover:visible hover:text-red-500 touch:visible max-md:size-9 dark:hover:text-red-400"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Delete module"
      >
        ×
      </Button>
    </div>
  );
}

import { useMemo, useState } from "react";
import { hasApplicationImporter, isWorkspaceModule } from "../../loader";
import type { ModuleKind, ParsedManifest, Workspace } from "../../model";
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

interface WorkspaceTreeProps {
  workspace: Workspace;
  activeModulePath: string | null;
  onOpenModule: (filePath: string) => void;
  onNewModule: (kind: ModuleKind) => void;
  onDeleteModule: (filePath: string) => Promise<void>;
  onRunModule: (filePath: string) => void;
}

interface TreeNode {
  manifest: ParsedManifest;
  relativeDir: string;
}

function buildNodes(workspace: Workspace): { applications: TreeNode[]; libraries: TreeNode[] } {
  const root = workspace.rootDir.endsWith("/") ? workspace.rootDir : workspace.rootDir + "/";
  const applications: TreeNode[] = [];
  const libraries: TreeNode[] = [];
  for (const [filePath, manifest] of workspace.modules) {
    if (!isWorkspaceModule(workspace, filePath)) continue;
    const relativeDir = filePath.slice(root.length).replace(/\/telo\.ya?ml$/, "");
    const node = { manifest, relativeDir };
    if (manifest.kind === "Application") applications.push(node);
    else libraries.push(node);
  }
  const byRel = (a: TreeNode, b: TreeNode) => a.relativeDir.localeCompare(b.relativeDir);
  applications.sort(byRel);
  libraries.sort(byRel);
  return { applications, libraries };
}

export function WorkspaceTree({
  workspace,
  activeModulePath,
  onOpenModule,
  onNewModule,
  onDeleteModule,
  onRunModule,
}: WorkspaceTreeProps) {
  const { applications, libraries } = useMemo(() => buildNodes(workspace), [workspace]);
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

  const importers = deleteTarget ? [...(workspace.importedBy.get(deleteTarget.filePath) ?? [])] : [];

  return (
    <>
      <TreeSection
        label="Applications"
        addLabel="New application"
        emptyText="No applications yet"
        onAdd={() => onNewModule("Application")}
      >
        {applications.map((node) => (
          <ModuleRow
            key={node.manifest.filePath}
            node={node}
            active={node.manifest.filePath === activeModulePath}
            workspace={workspace}
            onOpen={() => onOpenModule(node.manifest.filePath)}
            onDelete={() => setDeleteTarget(node.manifest)}
            onRun={() => onRunModule(node.manifest.filePath)}
          />
        ))}
      </TreeSection>

      <div className="mx-3 border-t border-zinc-100 dark:border-zinc-800" />

      <TreeSection
        label="Libraries"
        addLabel="New library"
        emptyText="No libraries yet"
        onAdd={() => onNewModule("Library")}
      >
        {libraries.map((node) => (
          <ModuleRow
            key={node.manifest.filePath}
            node={node}
            active={node.manifest.filePath === activeModulePath}
            workspace={workspace}
            onOpen={() => onOpenModule(node.manifest.filePath)}
            onDelete={() => setDeleteTarget(node.manifest)}
          />
        ))}
      </TreeSection>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.metadata.name}?</DialogTitle>
            <DialogDescription>
              This will remove the module directory from disk.
              {importers.length > 0 && (
                <>
                  {" "}
                  {importers.length} importer{importers.length === 1 ? "" : "s"} will have their
                  Telo.Import entries for this module removed:
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {importers.length > 0 && (
            <ul className="max-h-40 overflow-y-auto rounded border border-zinc-200 bg-zinc-50 p-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
              {importers.map((path) => (
                <li key={path} className="truncate">
                  {workspace.modules.get(path)?.metadata.name ?? path}
                </li>
              ))}
            </ul>
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

interface TreeSectionProps {
  label: string;
  addLabel: string;
  emptyText: string;
  onAdd: () => void;
  children: React.ReactNode;
}

function TreeSection({ label, addLabel, emptyText, onAdd, children }: TreeSectionProps) {
  const childCount = Array.isArray(children) ? children.length : children ? 1 : 0;

  return (
    <div className="pb-1 pt-2">
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          {label}
        </span>
        <Button variant="ghost" size="icon-xs" onClick={onAdd} title={addLabel}>
          +
        </Button>
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
  node: TreeNode;
  active: boolean;
  workspace: Workspace;
  onOpen: () => void;
  onDelete: () => void;
  onRun?: () => void;
}

function ModuleRow({ node, active, workspace, onOpen, onDelete, onRun }: ModuleRowProps) {
  const isLibrary = node.manifest.kind === "Library";
  const dim = isLibrary && !hasApplicationImporter(workspace, node.manifest.filePath);
  const icon = isLibrary ? "□" : "▷";
  const diagState = useDiagnosticsState();
  const summary = summarizeFiles(diagState, getModuleFiles(node.manifest));

  const base = "flex items-center gap-1.5 px-4 py-0.5 cursor-pointer select-none group";
  const hoverOrActive = active
    ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900";

  return (
    <div className={`${base} ${hoverOrActive} ${dim ? "opacity-50" : ""}`} onClick={onOpen}>
      <span className="text-zinc-400">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{node.manifest.metadata.name}</span>
      <DiagnosticBadge summary={summary} size="sm" />
      {dim && (
        <span className="shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          no importers
        </span>
      )}
      {onRun && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="invisible text-zinc-400 group-hover:visible hover:text-emerald-600 dark:hover:text-emerald-400"
          onClick={(e) => {
            e.stopPropagation();
            onRun();
          }}
          title="Run"
        >
          ▶
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="invisible text-zinc-400 group-hover:visible hover:text-red-500 dark:hover:text-red-400"
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

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
  onCreateModule: (kind: ModuleKind, relativePath: string, name: string) => Promise<void>;
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
  onCreateModule,
  onDeleteModule,
  onRunModule,
}: WorkspaceTreeProps) {
  const { applications, libraries } = useMemo(() => buildNodes(workspace), [workspace]);
  const [creatingKind, setCreatingKind] = useState<ModuleKind | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ParsedManifest | null>(null);
  const [deleting, setDeleting] = useState(false);

  function startCreate(kind: ModuleKind) {
    setCreatingKind(kind);
    setNewName("");
    setCreateError(null);
  }

  function cancelCreate() {
    setCreatingKind(null);
    setNewName("");
    setCreateError(null);
  }

  async function submitCreate() {
    if (!creatingKind) return;
    const name = newName.trim();
    if (!name) return;
    const parentDir = creatingKind === "Application" ? "apps" : "libs";
    const relativePath = `${parentDir}/${name}`;
    setCreating(true);
    setCreateError(null);
    try {
      await onCreateModule(creatingKind, relativePath, name);
      cancelCreate();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

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
        parentDir="apps"
        onAdd={() => startCreate("Application")}
        adding={creatingKind === "Application"}
        newName={newName}
        onNewNameChange={setNewName}
        onSubmitCreate={submitCreate}
        onCancelCreate={cancelCreate}
        createError={createError}
        creating={creating}
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
        parentDir="libs"
        onAdd={() => startCreate("Library")}
        adding={creatingKind === "Library"}
        newName={newName}
        onNewNameChange={setNewName}
        onSubmitCreate={submitCreate}
        onCancelCreate={cancelCreate}
        createError={createError}
        creating={creating}
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
  parentDir: string;
  onAdd: () => void;
  adding: boolean;
  newName: string;
  onNewNameChange: (v: string) => void;
  onSubmitCreate: () => void;
  onCancelCreate: () => void;
  createError: string | null;
  creating: boolean;
  children: React.ReactNode;
}

function TreeSection({
  label,
  addLabel,
  emptyText,
  parentDir,
  onAdd,
  adding,
  newName,
  onNewNameChange,
  onSubmitCreate,
  onCancelCreate,
  createError,
  creating,
  children,
}: TreeSectionProps) {
  const childCount = Array.isArray(children) ? children.length : children ? 1 : 0;
  const inputCls =
    "w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100";

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
      {childCount === 0 && !adding && (
        <div className="px-4 py-1 text-xs italic text-zinc-400 dark:text-zinc-600">
          {emptyText}
        </div>
      )}
      {children}
      {adding && (
        <div className="mx-3 mt-1 flex flex-col gap-1.5">
          <input
            autoFocus
            value={newName}
            onChange={(e) => onNewNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmitCreate();
              if (e.key === "Escape") onCancelCreate();
            }}
            placeholder="module-name"
            className={inputCls}
          />
          <p className="text-[10px] text-zinc-400 dark:text-zinc-600">
            Will be created at <code>{parentDir}/{newName.trim() || "…"}</code>
          </p>
          {createError && <p className="text-xs text-red-500 dark:text-red-400">{createError}</p>}
          <div className="flex gap-1">
            <Button
              size="xs"
              onClick={onSubmitCreate}
              disabled={!newName.trim() || creating}
            >
              {creating ? "Creating…" : "Create"}
            </Button>
            <Button variant="ghost" size="xs" onClick={onCancelCreate} disabled={creating}>
              Cancel
            </Button>
          </div>
        </div>
      )}
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

import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
} from "lucide-react";
import { useState } from "react";
import type { FileNode } from "../../loader";
import { pathDirname } from "../../loader/paths";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";

interface FileExplorerProps {
  rootDir: string;
  tree: FileNode[];
  expandedDirs: Set<string>;
  activeFilePath: string | null;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onCreateFile: (parentDir: string, name: string) => Promise<void>;
  onCreateFolder: (parentDir: string, name: string) => Promise<void>;
  onRename: (path: string, newName: string) => Promise<void>;
  onDelete: (path: string) => Promise<void>;
  onMove: (from: string, toDir: string) => Promise<void>;
}

type Editing =
  | { mode: "create-file" | "create-folder"; parentDir: string }
  | { mode: "rename"; path: string }
  | null;

const inputCls =
  "w-full rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100";

export function FileExplorer({
  rootDir,
  tree = [],
  expandedDirs,
  activeFilePath,
  onToggleDir,
  onOpenFile,
  onCreateFile,
  onCreateFolder,
  onRename,
  onDelete,
  onMove,
}: FileExplorerProps) {
  const [editing, setEditing] = useState<Editing>(null);
  // The explorer's selected node (independent of the open file tab). Drives the
  // target directory for the header New file / New folder buttons.
  const [selected, setSelected] = useState<{ path: string; isDirectory: boolean } | null>(null);

  // Directory a new file/folder lands in: the selected directory, the selected
  // file's directory, or the root when nothing is selected.
  function createTargetDir(): string {
    if (!selected) return rootDir;
    return selected.isDirectory ? selected.path : pathDirname(selected.path);
  }

  function startCreate(parentDir: string, mode: "create-file" | "create-folder") {
    if (!expandedDirs.has(parentDir) && parentDir !== rootDir) onToggleDir(parentDir);
    setEditing({ mode, parentDir });
  }

  async function commitEditing(name: string) {
    const trimmed = name.trim();
    const current = editing;
    setEditing(null);
    if (!current || !trimmed) return;
    if (current.mode === "rename") await onRename(current.path, trimmed);
    else if (current.mode === "create-folder") await onCreateFolder(current.parentDir, trimmed);
    else await onCreateFile(current.parentDir, trimmed);
  }

  const ctx: RowContext = {
    expandedDirs,
    activeFilePath,
    selectedPath: selected?.path ?? null,
    editing,
    rootDir,
    onToggleDir,
    onOpenFile,
    onSelect: (node) => setSelected({ path: node.path, isDirectory: node.isDirectory }),
    onMove,
    onDelete,
    startCreate,
    startRename: (path: string) => setEditing({ mode: "rename", path }),
    commitEditing,
    cancelEditing: () => setEditing(null),
  };

  return (
    <div className="pb-1 pt-2">
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          Explorer
        </span>
        <div className="flex">
          <Button
            variant="ghost"
            size="icon-xs"
            title="New file"
            onClick={() => startCreate(createTargetDir(), "create-file")}
          >
            <FilePlus className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="New folder"
            onClick={() => startCreate(createTargetDir(), "create-folder")}
          >
            <FolderPlus className="size-3" />
          </Button>
        </div>
      </div>

      <div
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(null);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const from = e.dataTransfer.getData("text/telo-path");
          if (from) void onMove(from, rootDir);
        }}
      >
        {tree.length === 0 && editing?.mode !== "create-file" && editing?.mode !== "create-folder" && (
          <div className="px-4 py-1 text-xs italic text-zinc-400 dark:text-zinc-600">
            No files
          </div>
        )}
        {editing && editing.mode !== "rename" && editing.parentDir === rootDir && (
          <EditingInput depth={0} ctx={ctx} placeholder={editing.mode === "create-folder" ? "folder-name" : "file-name"} />
        )}
        {tree.map((node) => (
          <TreeRow key={node.path} node={node} depth={0} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

interface RowContext {
  expandedDirs: Set<string>;
  activeFilePath: string | null;
  selectedPath: string | null;
  editing: Editing;
  rootDir: string;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSelect: (node: FileNode) => void;
  onMove: (from: string, toDir: string) => Promise<void>;
  onDelete: (path: string) => Promise<void>;
  startCreate: (parentDir: string, mode: "create-file" | "create-folder") => void;
  startRename: (path: string) => void;
  commitEditing: (name: string) => void;
  cancelEditing: () => void;
}

function TreeRow({ node, depth, ctx }: { node: FileNode; depth: number; ctx: RowContext }) {
  const expanded = ctx.expandedDirs.has(node.path);
  const isRenaming = ctx.editing?.mode === "rename" && ctx.editing.path === node.path;
  const indent = { paddingLeft: `${depth * 12 + 12}px` };

  if (isRenaming) {
    return <EditingInput depth={depth} ctx={ctx} initial={node.name} />;
  }

  const highlighted =
    node.path === ctx.selectedPath ||
    (!node.isDirectory && node.path === ctx.activeFilePath);
  const rowCls = `group flex items-center gap-1 py-0.5 pr-2 text-xs cursor-pointer select-none ${
    highlighted
      ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
      : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
  }`;

  const dropToDir = node.isDirectory ? node.path : null;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={rowCls}
            style={indent}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/telo-path", node.path)}
            onDragOver={dropToDir ? (e) => e.preventDefault() : undefined}
            onDrop={
              dropToDir
                ? (e) => {
                    e.stopPropagation();
                    const from = e.dataTransfer.getData("text/telo-path");
                    if (from && from !== node.path) void ctx.onMove(from, dropToDir);
                  }
                : undefined
            }
            onClick={() => {
              ctx.onSelect(node);
              if (node.isDirectory) ctx.onToggleDir(node.path);
              else ctx.onOpenFile(node.path);
            }}
          >
            {node.isDirectory ? (
              <>
                {expanded ? (
                  <ChevronDown className="size-3 shrink-0 text-zinc-400" />
                ) : (
                  <ChevronRight className="size-3 shrink-0 text-zinc-400" />
                )}
                {expanded ? (
                  <FolderOpen className="size-3.5 shrink-0 text-zinc-400" />
                ) : (
                  <Folder className="size-3.5 shrink-0 text-zinc-400" />
                )}
              </>
            ) : (
              <FileIcon className="ml-3 size-3.5 shrink-0 text-zinc-400" />
            )}
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          {node.isDirectory && (
            <>
              <ContextMenuItem onSelect={() => ctx.startCreate(node.path, "create-file")}>
                New file
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => ctx.startCreate(node.path, "create-folder")}>
                New folder
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={() => ctx.startRename(node.path)}>Rename</ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => void ctx.onDelete(node.path)}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {node.isDirectory && expanded && (
        <>
          {ctx.editing &&
            ctx.editing.mode !== "rename" &&
            ctx.editing.parentDir === node.path && (
              <EditingInput
                depth={depth + 1}
                ctx={ctx}
                placeholder={ctx.editing.mode === "create-folder" ? "folder-name" : "file-name"}
              />
            )}
          {node.children?.map((child) => (
            <TreeRow key={child.path} node={child} depth={depth + 1} ctx={ctx} />
          ))}
        </>
      )}
    </>
  );
}

function EditingInput({
  depth,
  ctx,
  initial = "",
  placeholder,
}: {
  depth: number;
  ctx: RowContext;
  initial?: string;
  placeholder?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="py-0.5 pr-2" style={{ paddingLeft: `${depth * 12 + 24}px` }}>
      <input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => ctx.commitEditing(value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") ctx.commitEditing(value);
          if (e.key === "Escape") ctx.cancelEditing();
        }}
        className={inputCls}
      />
    </div>
  );
}

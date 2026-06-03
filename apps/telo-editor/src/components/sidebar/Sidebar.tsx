import type { FileNode } from "../../loader";
import type { ModuleKind, Workspace } from "../../model";
import { FileExplorer } from "./FileExplorer";
import { SectionDivider } from "./primitives";
import { WorkspaceTree } from "./WorkspaceTree";

interface SidebarProps {
  workspace: Workspace | null;
  activeModulePath: string | null;
  activeTabId: string | null;
  fileTree: FileNode[];
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onCreateFile: (parentDir: string, name: string) => Promise<void>;
  onCreateFolder: (parentDir: string, name: string) => Promise<void>;
  onRenamePath: (path: string, newName: string) => Promise<void>;
  onDeletePath: (path: string) => Promise<void>;
  onMovePath: (from: string, toDir: string) => Promise<void>;
  onOpenModule: (filePath: string) => void;
  onCreateModule: (kind: ModuleKind, relativePath: string, name: string) => Promise<void>;
  onDeleteModule: (filePath: string) => Promise<void>;
  onRunModule: (filePath: string) => void;
}

export function Sidebar({
  workspace,
  activeModulePath,
  activeTabId,
  fileTree,
  expandedDirs,
  onToggleDir,
  onOpenFile,
  onCreateFile,
  onCreateFolder,
  onRenamePath,
  onDeletePath,
  onMovePath,
  onOpenModule,
  onCreateModule,
  onDeleteModule,
  onRunModule,
}: SidebarProps) {
  if (!workspace) return null;
  return (
    <div className="flex h-full w-56 flex-col overflow-y-auto border-r border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <FileExplorer
        rootDir={workspace.rootDir}
        tree={fileTree}
        expandedDirs={expandedDirs}
        activeFilePath={activeTabId}
        onToggleDir={onToggleDir}
        onOpenFile={onOpenFile}
        onCreateFile={onCreateFile}
        onCreateFolder={onCreateFolder}
        onRename={onRenamePath}
        onDelete={onDeletePath}
        onMove={onMovePath}
      />
      <SectionDivider />
      <WorkspaceTree
        workspace={workspace}
        activeModulePath={activeModulePath}
        onOpenModule={onOpenModule}
        onCreateModule={onCreateModule}
        onDeleteModule={onDeleteModule}
        onRunModule={onRunModule}
      />
    </div>
  );
}

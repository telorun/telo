import type { FileNode } from "../../loader";
import type { ModuleKind, Workspace } from "../../model";
import { useIsMobile } from "../../hooks/useIsMobile";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../ui/sheet";
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
  onNewModule: (kind: ModuleKind) => void;
  onDeleteModule: (filePath: string) => Promise<void>;
  onRunModule: (filePath: string) => void;
  /** Phone width only, where the sidebar is a drawer over the content. */
  drawerOpen: boolean;
  onDrawerOpenChange: (open: boolean) => void;
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
  onNewModule,
  onDeleteModule,
  onRunModule,
  drawerOpen,
  onDrawerOpenChange,
}: SidebarProps) {
  const isMobile = useIsMobile();
  if (!workspace) return null;
  const content = (
    <div className="flex h-full w-56 flex-col overflow-y-auto border-r border-zinc-200 bg-white text-sm max-md:w-full max-md:border-r-0 dark:border-zinc-800 dark:bg-zinc-950">
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
        onNewModule={onNewModule}
        onDeleteModule={onDeleteModule}
        onRunModule={onRunModule}
      />
    </div>
  );
  if (!isMobile) return content;
  return (
    <Sheet open={drawerOpen} onOpenChange={onDrawerOpenChange}>
      <SheetContent side="left" className="w-4/5 gap-0 p-0 pt-10">
        <SheetTitle className="sr-only">Workspace</SheetTitle>
        <SheetDescription className="sr-only">Files, applications and libraries</SheetDescription>
        {content}
      </SheetContent>
    </Sheet>
  );
}

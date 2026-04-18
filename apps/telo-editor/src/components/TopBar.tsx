import type { ParsedManifest, Workspace } from "../model";
import { Button } from "./ui/button";

function formatSubPath(workspace: Workspace | null, manifest: ParsedManifest | null): string {
  if (!workspace) return "";
  if (!manifest) return workspace.rootDir;
  const root = workspace.rootDir.endsWith("/") ? workspace.rootDir : workspace.rootDir + "/";
  if (manifest.filePath.startsWith(root)) {
    return manifest.filePath.slice(root.length);
  }
  // Non-workspace module (e.g. transitively-loaded import) — show the raw path.
  return manifest.filePath;
}

interface TopBarProps {
  workspace: Workspace | null;
  activeManifest: ParsedManifest | null;
  onOpen: () => void;
  onOpenSettings: () => void;
  onRun?: () => void;
}

export function TopBar({
  workspace,
  activeManifest,
  onOpen,
  onOpenSettings,
  onRun,
}: TopBarProps) {
  const label = activeManifest?.metadata.name ?? (workspace ? "(no module selected)" : "");
  const subPath = formatSubPath(workspace, activeManifest);
  const canRun = activeManifest?.kind === "Application";

  return (
    <div className="flex h-10 items-center border-b border-zinc-200 bg-white px-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <span className="font-semibold text-zinc-900 dark:text-zinc-100">Telo Editor</span>

      <div className="mx-4 flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-zinc-500 dark:text-zinc-400">
        {workspace && (
          <>
            <span className="truncate text-zinc-700 dark:text-zinc-300">{label}</span>
            {subPath && (
              <span className="truncate text-xs text-zinc-400 dark:text-zinc-600">{subPath}</span>
            )}
          </>
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onOpen}>
          Open workspace
        </Button>
        <Button variant="ghost" size="sm" disabled>
          Save
        </Button>
        <Button
          variant={canRun ? "default" : "ghost"}
          size="sm"
          onClick={canRun ? onRun : undefined}
          disabled={!canRun}
        >
          Run
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenSettings}>
          Settings
        </Button>
      </div>
    </div>
  );
}

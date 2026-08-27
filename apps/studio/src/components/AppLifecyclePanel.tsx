import { Button } from "./ui/button";

interface AppLifecyclePanelProps {
  onOpen: () => void;
  /** Opens the starter-template gallery (app templates) in a fresh workspace. */
  onStartFromTemplate: () => void;
  /** `"chooser"` where a directory picker exists, `"single"` where every open
   *  resolves to the one browser-stored workspace — which is a different offer,
   *  not the same one worded differently. */
  openMode: "chooser" | "single";
  /** If present, FSA couldn't silently re-attach to this path — surface it as
   *  a hint so the user can re-open with one click. Chooser mode only: nothing
   *  to re-attach to where the single workspace always reopens itself. */
  recentRootDir?: string | null;
}

export function AppLifecyclePanel({
  onOpen,
  onStartFromTemplate,
  openMode,
  recentRootDir,
}: AppLifecyclePanelProps) {
  const chooser = openMode === "chooser";
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 px-6 text-center dark:bg-zinc-900">
      <div className="flex flex-col items-center gap-1">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">No workspace open</p>
        <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">
          {chooser
            ? "Start from a working template, or open a directory to load its modules. An empty directory becomes a new workspace — you can add applications and libraries from the sidebar."
            : "Start from a working template, or create an empty workspace. This browser can't open a directory, so the workspace is kept in its own storage — you can add applications and libraries from the sidebar."}
        </p>
      </div>
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2">
          <Button variant="default" onClick={onStartFromTemplate}>
            Start from a template
          </Button>
          <Button variant="outline" onClick={onOpen}>
            {chooser ? "Open folder…" : "Create workspace"}
          </Button>
        </div>
        {chooser && recentRootDir && (
          <button
            className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            onClick={onOpen}
            title="Pick the same directory again to re-open"
          >
            Recent: {recentRootDir}
          </button>
        )}
      </div>
    </div>
  );
}

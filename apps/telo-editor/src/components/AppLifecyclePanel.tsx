import { Button } from "./ui/button";

interface AppLifecyclePanelProps {
  onOpen: () => void;
  /** If present, FSA couldn't silently re-attach to this path — surface it as
   *  a hint so the user can re-open with one click. */
  recentRootDir?: string | null;
}

export function AppLifecyclePanel({ onOpen, recentRootDir }: AppLifecyclePanelProps) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 px-6 text-center dark:bg-zinc-900">
      <div className="flex flex-col items-center gap-1">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">No workspace open</p>
        <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">
          Open a directory to load its modules. An empty directory becomes a new workspace — you
          can add applications and libraries from the sidebar.
        </p>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Button variant="default" onClick={onOpen}>
          Open workspace
        </Button>
        {recentRootDir && (
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

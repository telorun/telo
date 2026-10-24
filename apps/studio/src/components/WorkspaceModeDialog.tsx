import type { WorkspaceMode } from "../run";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { WORKSPACE_MODE_OPTIONS } from "./workspace-mode-options";

interface WorkspaceModeDialogProps {
  /** Shown while the open workspace has no mode yet. */
  open: boolean;
  onChoose: (mode: WorkspaceMode) => void;
}

/** Asked the first time a workspace opens: how it is used. Nothing reaches a
 *  runner until it is answered; the workspace menu changes it later. */
export function WorkspaceModeDialog({ open, onChoose }: WorkspaceModeDialogProps) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>How do you want to work in this workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            You can change this later from the workspace menu.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          {WORKSPACE_MODE_OPTIONS.map(({ mode, label, description, icon: Icon }) => (
            <button
              key={mode}
              type="button"
              onClick={() => onChoose(mode)}
              className="flex items-start gap-3 rounded-md border border-zinc-200 p-3 text-left hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-zinc-500" aria-hidden />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</span>
                <span className="block text-xs text-zinc-600 dark:text-zinc-400">{description}</span>
              </span>
            </button>
          ))}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

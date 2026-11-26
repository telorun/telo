import { Cloud } from "lucide-react";
import { useState } from "react";
import { useCloud } from "../cloud/context";
import { BuildRequest } from "./agent/BuildRequest";
import { NewCloudProjectDialog } from "./cloud/NewCloudProjectDialog";
import { OpenCloudProjectDialog } from "./cloud/OpenCloudProjectDialog";
import { DotGridBackdrop } from "./DotGridBackdrop";
import { Button } from "./ui/button";

interface AppLifecyclePanelProps {
  onOpen: () => void;
  /** Opens the starter gallery (app starters) in a fresh workspace. */
  onStartFromStarter: () => void;
  /** `"chooser"` where a directory picker exists, `"single"` where every open
   *  resolves to the one browser-stored workspace — which is a different offer,
   *  not the same one worded differently. */
  openMode: "chooser" | "single";
  /** The last workspace, when it was not restored silently — shown so the user
   *  can re-open it with one click. Chooser mode only: nothing to re-attach to
   *  where the single workspace always reopens itself. */
  recent?: { label: string; opensBrowserWorkspace: boolean } | null;
  /** Opens the browser-stored workspace by its backend. */
  onOpenBrowserWorkspace?: () => void;
  /** Present where the agent is offered: opens the browser workspace and sends
   *  the request there. Resolves false when no workspace was opened, and the
   *  request then stays in the input. */
  onBuild?: (request: string) => Promise<boolean>;
}

export function AppLifecyclePanel({
  onOpen,
  onStartFromStarter,
  openMode,
  recent,
  onOpenBrowserWorkspace,
  onBuild,
}: AppLifecyclePanelProps) {
  const chooser = openMode === "chooser";
  const cloud = useCloud();
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const cloudStatus = cloud.session.status;
  const openHint = chooser
    ? "Open a directory to load its modules. An empty directory becomes a new workspace."
    : "This browser can't open a directory, so the workspace is kept in the browser's own storage.";
  return (
    <div className="relative h-full flex-1 overflow-y-auto bg-zinc-50 text-center dark:bg-zinc-900">
      <div className="relative flex min-h-full flex-col items-center gap-5 px-6 py-8">
      <DotGridBackdrop />
      <div className="my-auto" />
      <div className="relative flex flex-col items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 md:text-3xl dark:text-zinc-100">
          Open a workspace
        </h1>
        <p className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">
          {chooser
            ? "Start from a starter — a working app copied into your workspace — or open a directory of your own."
            : "Start from a starter — a working app copied into your workspace — or open the workspace kept in this browser."}
        </p>
      </div>
      <div className="relative flex flex-col items-center gap-2">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="default" onClick={onStartFromStarter}>
            Start from a starter
          </Button>
          <Button variant="outline" onClick={onOpen} title={openHint}>
            {chooser ? "Open folder…" : "Open browser workspace"}
          </Button>
          {cloudStatus === "signedIn" && (
            <Button variant="outline" onClick={() => setCloudDialogOpen(true)}>
              <Cloud />
              Open from Telo Cloud…
            </Button>
          )}
          {cloudStatus === "anonymous" && (
            <Button variant="outline" onClick={cloud.signIn}>
              <Cloud />
              Sign in to Telo Cloud
            </Button>
          )}
        </div>
        {chooser && recent && (
          <button
            className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            onClick={recent.opensBrowserWorkspace ? onOpenBrowserWorkspace : onOpen}
            title={
              recent.opensBrowserWorkspace
                ? "Re-open the workspace kept in this browser"
                : "Pick the same directory again to re-open"
            }
          >
            Recent: {recent.label}
          </button>
        )}
      </div>
      {onBuild && (
        <BuildRequest
          onBuild={onBuild}
          subtitle="Describe it and the agent builds it in your browser workspace."
          sendTitle="Build in the browser workspace (Enter)"
        />
      )}
      <OpenCloudProjectDialog
        open={cloudDialogOpen}
        onOpenChange={setCloudDialogOpen}
        onNewProject={() => setNewProjectOpen(true)}
      />
      <NewCloudProjectDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} />
      <div className="my-auto" />
      </div>
    </div>
  );
}

import {
  ChevronDown,
  Cloud,
  GitBranch,
  GitCommitHorizontal,
  Lock,
  RefreshCw,
  Rocket,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { CloudStage } from "../../cloud/api";
import { consoleStagesUrl } from "../../cloud/console-links";
import { useCloud } from "../../cloud/context";
import { repositoryRefusalMessage } from "../../cloud/refusal-messages";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { CommitDialog } from "./CommitDialog";
import { ConflictDialog } from "./ConflictDialog";
import { PublishDialog, type PublishTarget } from "./PublishDialog";
import { PublishedModulesDialog } from "./PublishedModulesDialog";

const OPERATION_LABEL = {
  committing: "Committing…",
  updating: "Updating…",
  discarding: "Discarding…",
  switching: "Switching branch…",
} as const;

interface CloudProjectBarProps {
  /** The module in the active pane, when it is one of this workspace's own. */
  activeModule: PublishTarget | null;
  /** Opens the active module's manifest in the source view. */
  onOpenManifest: () => void;
  /** Opens the active module's Cloud view. */
  onOpenCloudView: () => void;
}

/** The strip above a Cloud project's tabs: which project and branch, what
 *  has changed, and what is done with it — commit, update, publish, and for an
 *  application publish and deploy to one of the project's stages. */
export function CloudProjectBar({
  activeModule,
  onOpenManifest,
  onOpenCloudView,
}: CloudProjectBarProps) {
  const cloud = useCloud();
  const { active, api } = cloud;
  const [commitOpen, setCommitOpen] = useState(false);
  const [modulesOpen, setModulesOpen] = useState(false);
  const [publishing, setPublishing] = useState<PublishTarget | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [stages, setStages] = useState<CloudStage[] | null>(null);
  const [stagesError, setStagesError] = useState<string | null>(null);

  if (!active) return null;
  const signedIn = cloud.session.status === "signedIn";
  const viewer = active.role === "viewer";
  const changes = active.changes ?? [];
  const busy = active.operation !== null;

  // Publishing reads the committed tree, so it waits until the module's own
  // directory holds nothing uncommitted.
  const moduleDirty =
    activeModule !== null &&
    changes.some(
      (change) =>
        activeModule.modulePath === "" || change.path.startsWith(`${activeModule.modulePath}/`),
    );
  const publishBlocked = !signedIn
    ? "Sign in to Telo Cloud to publish."
    : active.baseCommit === null
      ? "Commit the module before publishing it."
      : moduleDirty
        ? "Commit this module's changes before publishing it."
        : active.changes === null
          ? "Reading the working copy…"
          : activeModule !== null && "refusal" in activeModule.telo
            ? activeModule.telo.refusal
            : null;

  function loadBranches(open: boolean) {
    if (!open || !active) return;
    setBranches(null);
    api.listBranches(active.projectId).then(setBranches, (err: unknown) => {
      setBranches([]);
      toast.error(repositoryRefusalMessage(err));
    });
  }

  function loadStages(open: boolean) {
    if (!open || !active) return;
    setStages(null);
    setStagesError(null);
    api.listStages(active.projectId).then(setStages, (err: unknown) => {
      setStagesError(repositoryRefusalMessage(err));
    });
  }

  const stagesUrl = consoleStagesUrl(
    cloud.session.status === "signedIn" ? cloud.session.identity.consoleUrl : null,
    active.projectId,
  );

  async function act(action: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    const result = await action();
    if (!result.ok) toast.error(result.message);
  }

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      <Cloud className="size-3.5 shrink-0" />
      <span className="max-w-48 truncate font-medium text-zinc-800 dark:text-zinc-200">
        {active.name}
      </span>

      <DropdownMenu onOpenChange={loadBranches}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" disabled={busy || !signedIn} title="Switch branch">
            <GitBranch />
            {active.branch}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
          <DropdownMenuLabel>Branches</DropdownMenuLabel>
          {branches === null && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
          {branches?.map((branch) => (
            <DropdownMenuItem
              key={branch}
              disabled={branch === active.branch}
              onSelect={() => void act(() => cloud.switchBranch(branch))}
            >
              {branch}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="ghost" size="xs" onClick={() => setCommitOpen(true)}>
        <GitCommitHorizontal />
        {active.changes === null
          ? "Changes…"
          : changes.length === 0
            ? "No changes"
            : `${changes.length} ${changes.length === 1 ? "change" : "changes"}`}
      </Button>

      {active.operation && <span>{OPERATION_LABEL[active.operation]}</span>}

      {active.behind && !busy && (
        <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
          The branch has new commits.
          <Button
            variant="outline"
            size="xs"
            disabled={!signedIn}
            onClick={() => void act(() => cloud.update())}
          >
            <RefreshCw />
            Update
          </Button>
        </span>
      )}

      {viewer && (
        <span className="flex items-center gap-1 text-amber-700 dark:text-amber-300">
          <Lock className="size-3" />
          Viewer · read-only
        </span>
      )}
      {!signedIn && <span>Signed out — changes stay on this device.</span>}

      <span className="flex-1" />

      {activeModule && !viewer && (
        <Button
          variant="ghost"
          size="xs"
          disabled={publishBlocked !== null || busy}
          title={
            publishBlocked ??
            `Publish ${activeModule.name} at the last commit, to run on telo ${"version" in activeModule.telo ? activeModule.telo.version : ""}`
          }
          onClick={() => setPublishing(activeModule)}
        >
          <Upload />
          Publish
        </Button>
      )}
      {activeModule && activeModule.kind === "Application" && !viewer && (
        <DropdownMenu onOpenChange={loadStages}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              disabled={publishBlocked !== null || busy}
              title={
                publishBlocked ??
                `Publish ${activeModule.name} at the last commit and deploy it to a stage`
              }
            >
              <Rocket />
              Publish and deploy
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
            <DropdownMenuLabel>Deploy to</DropdownMenuLabel>
            {stagesError && (
              <DropdownMenuItem disabled className="whitespace-normal text-destructive">
                {stagesError}
              </DropdownMenuItem>
            )}
            {stages === null && !stagesError && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
            {stages?.length === 0 && (
              <>
                <DropdownMenuItem disabled>This project has no stage yet.</DropdownMenuItem>
                {stagesUrl && (
                  <DropdownMenuItem asChild>
                    <a href={stagesUrl} target="_blank" rel="noreferrer">
                      Add a stage in the Telo Cloud console
                    </a>
                  </DropdownMenuItem>
                )}
              </>
            )}
            {stages?.map((stage) => {
              // Deploying to a protected stage is a project admin's.
              const locked = stage.protected && active.role !== "admin";
              return (
                <DropdownMenuItem
                  key={stage.id}
                  disabled={locked}
                  onSelect={() =>
                    setPublishing({
                      ...activeModule,
                      deployTo: { stageId: stage.id, stageName: stage.name },
                    })
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{stage.name}</span>
                  {locked && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Lock className="size-3" />
                      admin only
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button variant="ghost" size="xs" disabled={!signedIn} onClick={() => setModulesOpen(true)}>
        Published modules
      </Button>

      <CommitDialog open={commitOpen} onOpenChange={setCommitOpen} />
      <ConflictDialog />
      <AlertDialog open={cloud.browserWorkspaceRemoval !== null}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the browser workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              The files you copied from the browser workspace are now committed to{" "}
              {cloud.browserWorkspaceRemoval?.projectName}. The browser workspace still holds its
              own copy of them on this device.
              {cloud.browserWorkspaceRemoval?.kept.length ? (
                <>
                  {" "}
                  {cloud.browserWorkspaceRemoval.kept.join(", ")} stay on this device: they hold
                  secrets that were not copied, or mark the files that do.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cloud.keepBrowserWorkspace}>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void cloud.removeBrowserWorkspace()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PublishedModulesDialog open={modulesOpen} onOpenChange={setModulesOpen} />
      <PublishDialog
        target={publishing}
        onOpenChange={(open) => !open && setPublishing(null)}
        onOpenManifest={onOpenManifest}
        onOpenCloudView={onOpenCloudView}
      />
    </div>
  );
}

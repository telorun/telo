import { Cloud, GitBranch, GitCommitHorizontal, Lock, RefreshCw, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useCloud } from "../../cloud/context";
import { repositoryRefusalMessage } from "../../cloud/refusal-messages";
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

interface CloudWorkspaceBarProps {
  /** The module in the active pane, when it is one of this workspace's own. */
  activeModule: PublishTarget | null;
  /** Opens the active module's manifest in the source view. */
  onOpenManifest: () => void;
}

/** The strip above a Cloud workspace's tabs: which workspace and branch, what
 *  has changed, and the three things done with it — commit, update, publish. */
export function CloudWorkspaceBar({ activeModule, onOpenManifest }: CloudWorkspaceBarProps) {
  const cloud = useCloud();
  const { active, api } = cloud;
  const [commitOpen, setCommitOpen] = useState(false);
  const [modulesOpen, setModulesOpen] = useState(false);
  const [publishing, setPublishing] = useState<PublishTarget | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);

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
          : null;

  function loadBranches(open: boolean) {
    if (!open || !active) return;
    setBranches(null);
    api.listBranches(active.workspaceId).then(setBranches, (err: unknown) => {
      setBranches([]);
      toast.error(repositoryRefusalMessage(err));
    });
  }

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
          title={publishBlocked ?? `Publish ${activeModule.name} at the last commit`}
          onClick={() => setPublishing(activeModule)}
        >
          <Upload />
          Publish
        </Button>
      )}
      <Button variant="ghost" size="xs" disabled={!signedIn} onClick={() => setModulesOpen(true)}>
        Published modules
      </Button>

      <CommitDialog open={commitOpen} onOpenChange={setCommitOpen} />
      <ConflictDialog />
      <PublishedModulesDialog open={modulesOpen} onOpenChange={setModulesOpen} />
      <PublishDialog
        target={publishing}
        onOpenChange={(open) => !open && setPublishing(null)}
        onOpenManifest={onOpenManifest}
      />
    </div>
  );
}

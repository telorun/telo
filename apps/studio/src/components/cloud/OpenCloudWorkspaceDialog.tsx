import { useEffect, useState } from "react";
import type { CloudWorkspace } from "../../cloud/api";
import { useCloud } from "../../cloud/context";
import { repositoryRefusalMessage } from "../../cloud/refusal-messages";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

interface OpenCloudWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "Open from Telo Cloud": the signed-in user's workspaces. */
export function OpenCloudWorkspaceDialog({ open, onOpenChange }: OpenCloudWorkspaceDialogProps) {
  const cloud = useCloud();
  const { api } = cloud;
  const [workspaces, setWorkspaces] = useState<CloudWorkspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    setWorkspaces(null);
    setError(null);
    api.listWorkspaces().then(
      (list) => {
        if (!stopped) setWorkspaces(list);
      },
      (err: unknown) => {
        if (!stopped) setError(repositoryRefusalMessage(err));
      },
    );
    return () => {
      stopped = true;
    };
  }, [api, open]);

  async function handleOpen(workspace: CloudWorkspace) {
    setOpening(workspace.id);
    setError(null);
    const result = await cloud.openWorkspace(workspace);
    setOpening(null);
    if (result.ok) onOpenChange(false);
    else setError(result.message);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Open from Telo Cloud</DialogTitle>
          <DialogDescription>
            A workspace is copied to this device. Your edits stay here until you commit them.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!workspaces && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {workspaces?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            You have no workspaces in this organization. Create one in the Telo Cloud console.
          </p>
        )}
        {workspaces && workspaces.length > 0 && (
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <button
                  type="button"
                  disabled={opening !== null}
                  onClick={() => void handleOpen(workspace)}
                  className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{workspace.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {workspace.slug}
                    </span>
                  </span>
                  {opening === workspace.id ? (
                    <span className="text-xs text-muted-foreground">Opening…</span>
                  ) : (
                    <Badge variant="outline">{workspace.effectiveRole}</Badge>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

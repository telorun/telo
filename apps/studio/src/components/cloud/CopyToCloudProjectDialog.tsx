import { useEffect, useState } from "react";
import type { CloudProject } from "../../cloud/api";
import { useCloud } from "../../cloud/context";
import { repositoryRefusalMessage } from "../../cloud/refusal-messages";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

interface CopyToCloudProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "Copy to Telo Cloud project": the projects the signed-in user can write
 *  to, and — when the chosen one already holds some of the paths — the list of
 *  what the copy would replace. */
export function CopyToCloudProjectDialog({ open, onOpenChange }: CopyToCloudProjectDialogProps) {
  const cloud = useCloud();
  const { api } = cloud;
  const [projects, setProjects] = useState<CloudProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    project: CloudProject;
    overwrites: string[];
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    setProjects(null);
    setError(null);
    setConfirming(null);
    api.listProjects().then(
      (list) => {
        if (!stopped) setProjects(list.filter((project) => project.effectiveRole !== "viewer"));
      },
      (err: unknown) => {
        if (!stopped) setError(repositoryRefusalMessage(err));
      },
    );
    return () => {
      stopped = true;
    };
  }, [api, open]);

  async function handleCopy(project: CloudProject, confirmedOverwrites: readonly string[]) {
    setCopying(project.id);
    setError(null);
    const result = await cloud.copyBrowserWorkspace(project, confirmedOverwrites);
    setCopying(null);
    if (result.status === "copied") {
      onOpenChange(false);
    } else if (result.status === "confirm") {
      setConfirming({ project, overwrites: result.overwrites });
    } else {
      setConfirming(null);
      setError(result.message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Copy to Telo Cloud project</DialogTitle>
          <DialogDescription>
            {confirming
              ? `${confirming.project.name} already holds ${
                  confirming.overwrites.length === 1 ? "this file" : "these files"
                }. Copying replaces ${
                  confirming.overwrites.length === 1 ? "it" : "them"
                } on this device; discarding the project's changes brings ${
                  confirming.overwrites.length === 1 ? "it" : "them"
                } back.`
              : "The browser workspace's files are copied into the project on this device and stay in the browser workspace too. Nothing reaches the project's git repository until you commit."}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {confirming ? (
          <>
            <ul className="max-h-60 space-y-0.5 overflow-y-auto font-mono text-xs">
              {confirming.overwrites.map((path) => (
                <li key={path} className="truncate">
                  {path}
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={copying !== null}
                onClick={() => setConfirming(null)}
              >
                Back
              </Button>
              <Button
                variant="destructive"
                disabled={copying !== null}
                onClick={() => void handleCopy(confirming.project, confirming.overwrites)}
              >
                {copying ? "Copying…" : "Replace and copy"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {!projects && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
            {projects?.length === 0 && (
              <p className="text-sm text-muted-foreground">
                You have no projects you can write to in this organization. Create one in the Telo
                Cloud console.
              </p>
            )}
            {projects && projects.length > 0 && (
              <ul className="max-h-80 space-y-1 overflow-y-auto">
                {projects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      disabled={copying !== null}
                      onClick={() => void handleCopy(project, [])}
                      className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{project.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {project.slug}
                        </span>
                      </span>
                      {copying === project.id ? (
                        <span className="text-xs text-muted-foreground">Copying…</span>
                      ) : (
                        <Badge variant="outline">{project.effectiveRole}</Badge>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from "react";
import type { CloudProject } from "../../cloud/api";
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

interface OpenCloudProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "Open from Telo Cloud": the signed-in user's projects. */
export function OpenCloudProjectDialog({ open, onOpenChange }: OpenCloudProjectDialogProps) {
  const cloud = useCloud();
  const { api } = cloud;
  const [projects, setProjects] = useState<CloudProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    setProjects(null);
    setError(null);
    api.listProjects().then(
      (list) => {
        if (!stopped) setProjects(list);
      },
      (err: unknown) => {
        if (!stopped) setError(repositoryRefusalMessage(err));
      },
    );
    return () => {
      stopped = true;
    };
  }, [api, open]);

  async function handleOpen(project: CloudProject) {
    setOpening(project.id);
    setError(null);
    const result = await cloud.openProject(project);
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
            A project is copied to this device. Your edits stay here until you commit them.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!projects && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {projects?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            You have no projects in this organization. Create one in the Telo Cloud console.
          </p>
        )}
        {projects && projects.length > 0 && (
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  disabled={opening !== null}
                  onClick={() => void handleOpen(project)}
                  className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{project.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {project.slug}
                    </span>
                  </span>
                  {opening === project.id ? (
                    <span className="text-xs text-muted-foreground">Opening…</span>
                  ) : (
                    <Badge variant="outline">{project.effectiveRole}</Badge>
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

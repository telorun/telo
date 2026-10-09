import { useCallback, useEffect, useState } from "react";
import type { PublishedModule, PublishedModuleVersion } from "../../cloud/api";
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

interface PublishedModulesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** What this project has published: each module, its versions and its
 *  visibility, which an admin may change. */
export function PublishedModulesDialog({ open, onOpenChange }: PublishedModulesDialogProps) {
  const { api, active } = useCloud();
  const projectId = active?.projectId ?? null;
  const isAdmin = active?.role === "admin";
  const [modules, setModules] = useState<PublishedModule[] | null>(null);
  const [versions, setVersions] = useState<Record<string, PublishedModuleVersion[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [makePublic, setMakePublic] = useState<PublishedModule | null>(null);

  const load = useCallback(() => {
    if (!projectId) return;
    setError(null);
    api.listModules(projectId).then(setModules, (err: unknown) =>
      setError(repositoryRefusalMessage(err)),
    );
  }, [api, projectId]);

  useEffect(() => {
    if (!open) return;
    setModules(null);
    setVersions({});
    load();
  }, [load, open]);

  function toggleVersions(module: PublishedModule) {
    if (!projectId) return;
    if (versions[module.id]) {
      setVersions((current) => {
        const next = { ...current };
        delete next[module.id];
        return next;
      });
      return;
    }
    api.listModuleVersions(projectId, module.id).then(
      (list) => setVersions((current) => ({ ...current, [module.id]: list })),
      (err: unknown) => setError(repositoryRefusalMessage(err)),
    );
  }

  function setVisibility(module: PublishedModule, visibility: "private" | "public") {
    if (!projectId) return;
    setError(null);
    api.setModuleVisibility(projectId, module, visibility).then(load, (err: unknown) => {
      setError(repositoryRefusalMessage(err));
      // Someone else changed it first: show what it is now.
      load();
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Published modules</DialogTitle>
            <DialogDescription>
              A private module can be pulled only inside this project; anyone can pull a public
              one.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!modules && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
          {modules?.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing has been published yet.</p>
          )}
          <ul className="max-h-96 space-y-2 overflow-y-auto">
            {(modules ?? []).map((module) => (
              <li key={module.id} className="rounded-lg border border-border p-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{module.modulePath}</span>
                    <code className="block break-all text-xs text-muted-foreground">
                      {module.ref}
                    </code>
                  </span>
                  <Badge variant={module.visibility === "public" ? "default" : "outline"}>
                    {module.visibility}
                  </Badge>
                </div>
                <div className="mt-1.5 flex gap-1.5">
                  <Button size="xs" variant="ghost" onClick={() => toggleVersions(module)}>
                    {versions[module.id] ? "Hide versions" : "Versions"}
                  </Button>
                  {isAdmin &&
                    (module.visibility === "private" ? (
                      <Button size="xs" variant="ghost" onClick={() => setMakePublic(module)}>
                        Make public…
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setVisibility(module, "private")}
                      >
                        Make private
                      </Button>
                    ))}
                </div>
                {versions[module.id] && (
                  <ul className="mt-1.5 space-y-1 border-t border-border pt-1.5 text-xs">
                    {versions[module.id]!.map((version) => (
                      <li key={version.id}>
                        <span className="font-medium">{version.version}</span>{" "}
                        <code className="break-all text-muted-foreground">{version.digest}</code>
                      </li>
                    ))}
                    {versions[module.id]!.length === 0 && (
                      <li className="text-muted-foreground">No versions.</li>
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>

      <AlertDialog open={makePublic !== null} onOpenChange={(o) => !o && setMakePublic(null)}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Make {makePublic?.modulePath} public?</AlertDialogTitle>
            <AlertDialogDescription>
              Anyone will be able to pull every version of this module, published so far and from
              now on, without signing in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (makePublic) setVisibility(makePublic, "public");
                setMakePublic(null);
              }}
            >
              Make public
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

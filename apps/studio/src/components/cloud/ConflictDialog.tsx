import { useEffect, useState } from "react";
import { useCloud } from "../../cloud/context";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

/** Settles an update's conflicts, one choice per file. Shown for as long as an
 *  update is waiting on them; editing is paused meanwhile. */
export function ConflictDialog() {
  const cloud = useCloud();
  const conflict = cloud.active?.conflict ?? null;
  const [theirs, setTheirs] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const busy = (cloud.active?.operation ?? null) !== null;

  useEffect(() => {
    setTheirs(new Set());
    setError(null);
  }, [conflict]);

  if (!conflict) return null;
  const headPaths = new Set(conflict.head.map((entry) => entry.path));

  function choose(path: string, side: "mine" | "theirs") {
    setTheirs((current) => {
      const next = new Set(current);
      if (side === "theirs") next.add(path);
      else next.delete(path);
      return next;
    });
  }

  async function apply() {
    setError(null);
    const result = await cloud.resolveConflicts(theirs);
    if (!result.ok) setError(result.message);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && cloud.cancelConflicts()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>The branch changed the same files you did</DialogTitle>
          <DialogDescription>
            Choose a version for each file. Everything else from the branch is merged into your
            working copy; nothing is committed until you commit.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {conflict.plan.conflicts.map((path) => {
            const takesTheirs = theirs.has(path);
            return (
              <li
                key={path}
                className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 break-all font-mono text-xs">
                  {path}
                  {!headPaths.has(path) && (
                    <span className="ml-1 text-muted-foreground">(deleted on the branch)</span>
                  )}
                </span>
                <Button
                  size="xs"
                  variant={takesTheirs ? "outline" : "secondary"}
                  aria-pressed={!takesTheirs}
                  onClick={() => choose(path, "mine")}
                >
                  Keep mine
                </Button>
                <Button
                  size="xs"
                  variant={takesTheirs ? "secondary" : "outline"}
                  aria-pressed={takesTheirs}
                  onClick={() => choose(path, "theirs")}
                >
                  Take theirs
                </Button>
              </li>
            );
          })}
        </ul>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={cloud.cancelConflicts}>
            Not now
          </Button>
          <Button disabled={busy} onClick={() => void apply()}>
            {busy ? "Updating…" : "Update working copy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from "react";
import { useCloud } from "../../cloud/context";
import type { PathChange } from "../../cloud/working-copy";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const STATUS_MARK: Record<PathChange["status"], { letter: string; className: string }> = {
  added: { letter: "A", className: "text-emerald-600 dark:text-emerald-400" },
  modified: { letter: "M", className: "text-amber-600 dark:text-amber-400" },
  deleted: { letter: "D", className: "text-red-600 dark:text-red-400" },
};

interface CommitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The changed paths, a message, and the commit. Also where local changes are
 *  discarded and where a push the host refused is redirected to a new branch. */
export function CommitDialog({ open, onOpenChange }: CommitDialogProps) {
  const cloud = useCloud();
  const { active, refreshChanges } = cloud;
  const [message, setMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setConfirmDiscard(false);
    refreshChanges();
  }, [open, refreshChanges]);

  if (!active) return null;
  const changes = active.changes ?? [];
  const busy = active.operation !== null;
  const signedIn = cloud.session.status === "signedIn";
  const canCommit = signedIn && active.role !== "viewer" && changes.length > 0 && !busy;

  async function run(action: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    setError(null);
    const result = await action();
    if (result.ok) {
      setMessage("");
      setBranchName("");
      onOpenChange(false);
    } else {
      setError(result.message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Commit to {active.branch}</DialogTitle>
          <DialogDescription>
            {active.changes === null
              ? "Reading the working copy…"
              : changes.length === 0
                ? "Nothing has changed since the last commit."
                : `${changes.length} changed ${changes.length === 1 ? "file" : "files"} in ${active.name}.`}
          </DialogDescription>
        </DialogHeader>

        {changes.length > 0 && (
          <ul className="max-h-56 overflow-y-auto rounded-lg border border-border p-2 font-mono text-xs">
            {changes.map((change) => (
              <li key={change.path} className="flex gap-2">
                <span className={`w-3 shrink-0 ${STATUS_MARK[change.status].className}`}>
                  {STATUS_MARK[change.status].letter}
                </span>
                <span className="break-all">{change.path}</span>
              </li>
            ))}
          </ul>
        )}

        {changes.length > 0 && (
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message"
            rows={3}
            disabled={!canCommit}
          />
        )}

        {!signedIn && (
          <p className="text-sm text-muted-foreground">Sign in to Telo Cloud to commit.</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {active.pushRejected && (
          <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p>
              The git host protects <code>{active.branch}</code>. Commit to a new branch created
              from the commit your changes are based on:
            </p>
            <div className="flex gap-2">
              <Input
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="New branch name"
                disabled={busy}
              />
              <Button
                disabled={!canCommit || !branchName.trim() || !message.trim()}
                onClick={() => void run(() => cloud.commitToNewBranch(branchName.trim(), message.trim()))}
              >
                Commit there
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          {changes.length > 0 &&
            active.role !== "viewer" &&
            (confirmDiscard ? (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => void run(() => cloud.discard())}
              >
                Discard {changes.length} {changes.length === 1 ? "change" : "changes"} — cannot be
                undone
              </Button>
            ) : (
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmDiscard(true)}>
                Discard changes…
              </Button>
            ))}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            disabled={!canCommit || !message.trim()}
            onClick={() => void run(() => cloud.commit(message.trim()))}
          >
            {active.operation === "committing" ? "Committing…" : "Commit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

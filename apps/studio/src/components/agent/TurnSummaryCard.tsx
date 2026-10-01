import { useState } from "react";
import { FileDiff, TriangleAlert, Undo2 } from "lucide-react";
import { useAgent } from "@/agent";
import type { AssistantMessage, TurnChanges, TurnRevert, TurnSummary } from "@/agent";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ai-elements/loader";
import { DiffHunks, LineCounts } from "./DiffHunks";
import { fileCount } from "./ToolCard";
import { WorkspaceFileLink } from "./WorkspaceFileLink";

const NONE_KEPT: readonly string[] = [];

function said(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pathsWith(revert: TurnRevert, outcome: "restored" | "skipped"): string[] {
  return revert.files.filter((file) => file.outcome === outcome).map((file) => file.path);
}

/** What the agent recorded when the turn was last reverted — by this client or
 *  another — and the restored paths the editor's own copy was left as it is for. */
function RevertOutcome({ revert, kept }: { revert: TurnRevert; kept: readonly string[] }) {
  const at = new Date(revert.revertedAt);
  const skipped = pathsWith(revert, "skipped");
  return (
    <div className="space-y-1">
      <div>
        Reverted{Number.isNaN(at.getTime()) ? "" : ` ${at.toLocaleString()}`}:{" "}
        {pathsWith(revert, "restored").length} restored, {skipped.length} skipped.
      </div>
      {skipped.length > 0 && (
        <div className="text-muted-foreground">
          Skipped, because they changed after the turn:
          <ul className="list-disc pl-4 font-mono">
            {skipped.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}
      {kept.length > 0 && (
        <div className="text-muted-foreground">
          Restored in the agent's workspace, but not in the editor — the editor's copy is not what this turn left. It
          will replace the restored file when you next send a message.
          <ul className="list-disc pl-4 font-mono">
            {kept.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The turn's net changes as diffs, as the changes route answered just now. */
function ChangesView({ changes }: { changes: TurnChanges }) {
  if (changes.files === null) {
    return <p className="text-muted-foreground">What this turn changed was not recorded.</p>;
  }
  if (changes.files.length === 0) return <p className="text-muted-foreground">This turn changed no files.</p>;
  return (
    <div className="space-y-2">
      {changes.files.map((file) => (
        <div key={file.path} className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{file.path}</span>
            {file.changedSince === null ? (
              <Badge variant="outline">not compared</Badge>
            ) : (
              file.changedSince && <Badge variant="outline">changed since</Badge>
            )}
          </div>
          {file.hunks ? (
            <DiffHunks hunks={file.hunks} />
          ) : (
            <p className="text-muted-foreground">
              {file.status === "deleted" ? "Deleted." : "No line diff: the file is not text, or is too large to compare."}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * What an ended turn did: the files it changed on balance, its check, the
 * manifests it ran and the tokens it spent — with its changes as diffs and a
 * revert, where the agent serves them. A turn from before the agent kept
 * checkpoints (`files: null`) has neither, and no file list: what it changed is
 * unknown, not nothing.
 */
export function TurnSummaryCard({ turn, summary }: { turn: AssistantMessage; summary: TurnSummary }) {
  const agent = useAgent();
  const { files } = summary;
  const [changes, setChanges] = useState<TurnChanges | null>(null);
  const [busy, setBusy] = useState<"changes" | "revert" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canView = agent.turnFeatures.changes && files !== null;
  // The agent refuses a revert while a turn of the conversation runs and on an
  // archived one, so neither offers it.
  const canRevert =
    agent.turnFeatures.revert &&
    files !== null &&
    files.length > 0 &&
    !agent.locked &&
    agent.conversation?.archived !== true;

  const toggleChanges = async () => {
    if (changes) {
      setChanges(null);
      return;
    }
    setError(null);
    setBusy("changes");
    try {
      setChanges(await agent.turnChanges(turn.id));
    } catch (err) {
      setError(said(err));
    } finally {
      setBusy(null);
    }
  };

  const revert = async () => {
    setConfirming(false);
    setError(null);
    setBusy("revert");
    try {
      await agent.revertTurn(turn.id);
      // What it showed is no longer what the files hold.
      setChanges(null);
    } catch (err) {
      setError(said(err));
    } finally {
      setBusy(null);
    }
  };

  const tokens = summary.usage.totalTokens;

  return (
    <div className="space-y-2 rounded-md border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">
          {files === null ? "Turn summary" : files.length === 0 ? "No files changed" : `${fileCount(files.length)} changed`}
        </span>
        {summary.check && (
          <Badge variant={summary.check === "failing" ? "destructive" : "secondary"}>check: {summary.check}</Badge>
        )}
        {tokens !== undefined && <span className="text-muted-foreground">{tokens} tokens</span>}
      </div>

      {files === null && <p className="text-muted-foreground">What this turn changed was not recorded.</p>}
      {files !== null && files.length > 0 && (
        <ul className="space-y-0.5">
          {files.map((file) => (
            <li key={file.path} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-muted-foreground">{file.status}</span>
              {file.status === "deleted" ? (
                <span className="min-w-0 truncate font-mono">{file.path}</span>
              ) : (
                <WorkspaceFileLink path={file.path} line={file.firstLine} className="truncate font-mono" />
              )}
              <LineCounts change={file} />
              {file.checkExitCode != null && file.checkExitCode !== 0 && (
                <TriangleAlert className="size-3 shrink-0 text-destructive" aria-label="telo check failed" />
              )}
            </li>
          ))}
        </ul>
      )}

      {summary.runs.length > 0 && (
        <ul className="space-y-0.5">
          {summary.runs.map((run, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-muted-foreground">ran</span>
              <span className="min-w-0 truncate font-mono">{run.path}</span>
              <Badge variant={run.exitCode === 0 ? "secondary" : "destructive"}>exit {run.exitCode}</Badge>
            </li>
          ))}
        </ul>
      )}

      {turn.revert && <RevertOutcome revert={turn.revert} kept={agent.revertKept.get(turn.id) ?? NONE_KEPT} />}
      {changes && <ChangesView changes={changes} />}
      {error && <p className="text-destructive">{error}</p>}

      {(canView || canRevert) && (
        <div className="flex items-center gap-2">
          {canView && (
            <Button variant="outline" size="xs" onClick={() => void toggleChanges()} disabled={busy !== null}>
              <FileDiff className="size-3" />
              {changes ? "Hide changes" : "View changes"}
            </Button>
          )}
          {canRevert && (
            <Button variant="outline" size="xs" onClick={() => setConfirming(true)} disabled={busy !== null}>
              <Undo2 className="size-3" />
              Revert
            </Button>
          )}
          {busy !== null && <Loader size={14} className="text-muted-foreground" />}
        </div>
      )}

      {files !== null && (
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revert {fileCount(files.length)}?</AlertDialogTitle>
              <AlertDialogDescription>
                Each file still holding what this turn left is put back to what it held before the turn, and a file
                the turn created is deleted. A file changed since is skipped, never overwritten. The conversation
                keeps this turn.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void revert()}>
                Revert
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

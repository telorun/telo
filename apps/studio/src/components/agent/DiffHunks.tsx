import type { DiffHunk, FileChange } from "@/agent";
import { cn } from "@/lib/utils";

const MARK = { context: " ", added: "+", removed: "-" } as const;

const LINE_STYLE = {
  context: "",
  added: "bg-green-500/10 text-green-700 dark:text-green-400",
  removed: "bg-red-500/10 text-red-700 dark:text-red-400",
} as const;

/** A line diff as the agent computed it: each hunk under its range, context
 *  lines as the hunk carries them. */
export function DiffHunks({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="overflow-x-auto rounded-md border font-mono text-xs">
      {hunks.map((hunk, i) => (
        <div key={i}>
          <div className="bg-muted/50 px-2 py-0.5 text-muted-foreground">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </div>
          {hunk.lines.map((line, j) => (
            <div key={j} className={cn("whitespace-pre px-2", LINE_STYLE[line.op])}>
              {MARK[line.op]}
              {line.text}
              {line.noNewline && <span className="text-muted-foreground"> (no newline at end of file)</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Lines added and removed; nothing for a file the agent did not compare. */
export function LineCounts({ change }: { change: Pick<FileChange, "added" | "removed"> }) {
  if (change.added === null || change.removed === null) return null;
  return (
    <span className="shrink-0 font-mono text-xs">
      <span className="text-green-700 dark:text-green-400">+{change.added}</span>{" "}
      <span className="text-red-700 dark:text-red-400">−{change.removed}</span>
    </span>
  );
}

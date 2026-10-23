import type { ReactNode } from "react";
import { CircleAlert, CircleHelp, CircleStop, FileText, MessageSquare, RotateCcw, Square } from "lucide-react";

import type { BuildOutcome, BuildPhase, BuildProgress } from "@/agent";
import { Loader } from "@/components/ai-elements/loader";
import { Button } from "@/components/ui/button";
import { toolHeadline } from "./ToolCard";
import { EditorFileContext, WorkspaceFileLink } from "./WorkspaceFileLink";

/**
 * The latest turn of the workspace's conversation, shown where the empty
 * workspace took the request: what was asked, what the agent is doing, the
 * files it has written. The conversation itself stays in the panel.
 */
export function BuildProgressCard({
  progress,
  editorFile,
  onStop,
  onRetry,
  onShowConversation,
}: {
  progress: BuildProgress;
  editorFile: (path: string) => string | null;
  onStop: () => void;
  /** Present when a failed turn can be picked back up. */
  onRetry?: () => void;
  onShowConversation: () => void;
}) {
  const { phase } = progress;
  const running = phase.kind !== "ended";
  const ended = phase.kind === "ended" ? endedText(phase.outcome) : null;

  return (
    <section
      aria-label="Agent build"
      className="relative flex w-full max-w-xl flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-5 text-left shadow-lg shadow-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/30"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-zinc-500 dark:text-zinc-400">
          {running ? <Loader size={18} /> : ended!.icon}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {running ? "Building in this workspace" : ended!.title}
          </h2>
          <p className="min-w-0 text-sm text-zinc-500 dark:text-zinc-400">
            {running ? <RunningLine phase={phase} /> : ended!.detail}
          </p>
        </div>
      </div>

      {progress.request && (
        <blockquote className="line-clamp-4 border-l-2 border-zinc-200 pl-3 text-sm whitespace-pre-wrap text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
          {progress.request}
        </blockquote>
      )}

      {progress.files.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium tracking-wide text-zinc-400 uppercase dark:text-zinc-500">
            {running ? "Written so far" : "Written"}
          </p>
          <EditorFileContext.Provider value={editorFile}>
            <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {progress.files.map((path) => (
                <li key={path} className="flex min-w-0 items-center gap-2 text-sm">
                  <FileText className="size-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
                  <WorkspaceFileLink path={path} className="min-w-0 truncate font-mono text-xs" />
                </li>
              ))}
            </ul>
          </EditorFileContext.Provider>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {running && (
          <Button variant="outline" size="sm" onClick={onStop} disabled={phase.kind === "stopping"}>
            <Square className="size-3.5" />
            Stop
          </Button>
        )}
        {onRetry && phase.kind === "ended" && phase.outcome.kind === "failed" && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCcw className="size-3.5" />
            Retry
          </Button>
        )}
        <Button variant={running ? "outline" : "default"} size="sm" onClick={onShowConversation}>
          <MessageSquare className="size-3.5" />
          {running ? "Show conversation" : "Continue in the conversation"}
        </Button>
      </div>
    </section>
  );
}

function RunningLine({ phase }: { phase: BuildPhase }) {
  switch (phase.kind) {
    case "starting":
      return "Starting the agent…";
    case "preparing":
      return "Preparing the workspace…";
    case "stopping":
      return "Stopping…";
    case "working": {
      const step = phase.step;
      if (step === null) return "Working…";
      if (step.kind === "thinking") return "Thinking…";
      if (step.kind === "replying") return "Writing a reply…";
      const args = toolHeadline(step.tool.args);
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-medium text-zinc-700 dark:text-zinc-300">{step.tool.name}</span>
          {args && (
            <span className="min-w-0 truncate font-mono text-xs" title={args}>
              {args}
            </span>
          )}
        </span>
      );
    }
    case "ended":
      return null;
  }
}

function endedText(outcome: BuildOutcome): { icon: ReactNode; title: string; detail: string } {
  switch (outcome.kind) {
    case "question":
      return {
        icon: <CircleHelp className="size-[18px]" />,
        title: "The agent has a question",
        detail: "Answer it in the conversation to keep building.",
      };
    case "max-steps":
      return {
        icon: <CircleStop className="size-[18px]" />,
        title: "The agent ran out of steps",
        detail: "Continue in the conversation to let it finish.",
      };
    case "stopped":
      return {
        icon: <CircleStop className="size-[18px]" />,
        title: "Stopped",
        detail: "The agent stopped before adding a module.",
      };
    case "failed":
      return {
        icon: <CircleAlert className="size-[18px] text-red-600" />,
        title: "The build failed",
        detail: outcome.message,
      };
    case "replied":
      return {
        icon: <MessageSquare className="size-[18px]" />,
        title: "The agent replied without adding a module",
        detail: "Read its reply and continue in the conversation.",
      };
  }
}

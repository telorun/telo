import { ArrowUp, Sparkles } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StarterPromptList } from "./StarterPromptList";

/** Where a workspace with nothing in it — or no workspace — takes the request
 *  for the agent, under a divider from the ways to start that come first: a
 *  composer and the starter prompts, one of which fills it. `onBuild` resolves
 *  false when the request went nowhere, and it then stays in the input. */
export function BuildRequest({
  onBuild,
  subtitle,
  sendTitle,
}: {
  onBuild: (request: string) => Promise<boolean>;
  subtitle: string;
  sendTitle: string;
}) {
  const [request, setRequest] = useState("");
  const [sending, setSending] = useState(false);
  const canSubmit = request.trim() !== "" && !sending;
  const submit = async () => {
    if (!canSubmit) return;
    setSending(true);
    try {
      if (await onBuild(request)) setRequest("");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="relative flex w-full max-w-2xl flex-col items-center gap-4">
      <div className="flex w-full items-center gap-3 text-xs text-zinc-400 dark:text-zinc-500">
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        or
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      </div>
      <div className="flex flex-col items-center gap-1">
        <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-zinc-100">
          <Sparkles className="size-4 text-zinc-500 dark:text-zinc-400" />
          What do you want to build?
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>
      </div>
      <div className="w-full rounded-2xl border border-zinc-200 bg-white p-2 text-left shadow-lg shadow-zinc-900/5 transition-shadow focus-within:border-zinc-400 focus-within:ring-4 focus-within:ring-ring/20 dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/30 dark:focus-within:border-zinc-600">
        <Textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || (e.shiftKey && !e.metaKey && !e.ctrlKey)) return;
            e.preventDefault();
            void submit();
          }}
          aria-label="What to build"
          placeholder="An HTTP service that…"
          disabled={sending}
          rows={2}
          className="max-h-[40vh] resize-none border-0 bg-transparent focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-center justify-between gap-2 pl-2.5">
          <span className="text-xs text-zinc-400 max-md:hidden dark:text-zinc-500">
            Enter to send · Shift+Enter for a new line
          </span>
          <Button
            size="icon"
            className="ml-auto rounded-full"
            onClick={() => void submit()}
            disabled={!canSubmit}
            title={sendTitle}
            aria-label="Build"
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>
      <div className="flex w-full flex-col items-center gap-2">
        <p className="text-xs font-medium tracking-wide text-zinc-400 uppercase dark:text-zinc-500">
          Try one of these
        </p>
        <StarterPromptList layout="grid" onPick={setRequest} />
      </div>
    </div>
  );
}

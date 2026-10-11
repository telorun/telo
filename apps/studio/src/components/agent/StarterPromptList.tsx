import { CalendarClock, Database, FileSearch, Sparkles, Webhook, type LucideIcon } from "lucide-react";

import { STARTER_PROMPTS } from "@/agent";
import { Button } from "@/components/ui/button";

const STARTER_ICONS: Record<string, LucideIcon> = {
  "webhook-ingest": Webhook,
  "ticket-api": Database,
  "scheduled-report": CalendarClock,
  "document-qa": FileSearch,
};

/** The starter requests, each handing its full prompt to `onPick`: a column
 *  for a narrow panel, or a two-column grid of cards with an icon each. */
export function StarterPromptList({
  onPick,
  layout = "list",
}: {
  onPick: (prompt: string) => void;
  layout?: "list" | "grid";
}) {
  if (layout === "grid") {
    return (
      <ul aria-label="Starter prompts" className="grid w-full grid-cols-2 gap-2 max-md:grid-cols-1">
        {STARTER_PROMPTS.map((starter) => {
          const Icon = STARTER_ICONS[starter.id] ?? Sparkles;
          return (
            <li key={starter.id}>
              <button
                type="button"
                className="flex h-full w-full items-start gap-2.5 rounded-xl border border-zinc-200 bg-white/80 p-3 text-left text-sm text-zinc-700 transition hover:-translate-y-0.5 hover:border-zinc-300 hover:bg-white hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none dark:border-zinc-800 dark:bg-zinc-950/80 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-950"
                title={starter.prompt}
                onClick={() => onPick(starter.prompt)}
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
                {starter.label}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ul aria-label="Starter prompts" className="flex w-full max-w-sm flex-col gap-1.5">
      {STARTER_PROMPTS.map((starter) => (
        <li key={starter.id}>
          <Button
            variant="outline"
            size="sm"
            className="h-auto w-full justify-start py-1.5 text-left whitespace-normal"
            title={starter.prompt}
            onClick={() => onPick(starter.prompt)}
          >
            {starter.label}
          </Button>
        </li>
      ))}
    </ul>
  );
}

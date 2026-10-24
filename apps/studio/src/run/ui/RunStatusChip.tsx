import { Loader2 } from "lucide-react";

import type { AppRunStatus } from "../context";

interface Props {
  status: AppRunStatus;
}

const NEUTRAL = "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
const LIVE = "bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200";
const GOOD = "bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-200";
const BAD = "bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-200";
const STOPPED = "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200";

/** One run's state: waiting, starting, running, or how it ended. */
export function RunStatusChip({ status }: Props) {
  const { label, className } = describe(status);
  const spinning = status.kind === "starting" || status.kind === "queued";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${className}`}
    >
      {spinning && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {label}
    </span>
  );
}

function describe(status: AppRunStatus): { label: string; className: string } {
  switch (status.kind) {
    case "queued":
      return { label: "Waiting", className: NEUTRAL };
    case "starting":
      return { label: "Starting", className: NEUTRAL };
    case "running":
      return { label: "Running", className: LIVE };
    case "exited":
      return status.code === 0
        ? { label: "Exited 0", className: GOOD }
        : { label: `Exited ${status.code}`, className: BAD };
    case "signalled":
      return { label: status.signal, className: BAD };
    case "failed":
      return { label: "Failed", className: BAD };
    case "stopped":
      return { label: "Stopped", className: STOPPED };
  }
}

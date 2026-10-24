import { Loader2 } from "lucide-react";

import type { WorkspaceSessionState } from "../workspace-session";

/** The workspace session's own state, where it is not simply up: coming up,
 *  suspended, waiting on terms, or unavailable. Nothing while it runs. */
export function SessionStatusChip({ session }: { session: WorkspaceSessionState }) {
  const described = describe(session);
  if (!described) return null;
  return (
    <span
      title={described.title}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${described.className}`}
    >
      {described.spinning && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {described.label}
    </span>
  );
}

function describe(
  session: WorkspaceSessionState,
): { label: string; className: string; title: string; spinning?: boolean } | null {
  const neutral = "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  const bad = "bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-200";
  if (session.phase === "connecting") {
    return { label: "Connecting", className: neutral, title: "Finding the workspace's session on the runner", spinning: true };
  }
  if (session.phase === "terms") {
    return { label: "Terms", className: neutral, title: "The runner's terms wait to be accepted" };
  }
  if (session.phase === "failed") {
    return { label: "Session unavailable", className: bad, title: session.problem ?? "" };
  }
  switch (session.status?.kind) {
    case "starting":
      return {
        label: "Session starting",
        className: neutral,
        title: session.progress ?? "The workspace's session is coming up",
        spinning: true,
      };
    case "suspended":
      return { label: "Suspended", className: neutral, title: "The session is suspended; Run resumes it" };
    case "failed":
      return { label: "Session failed", className: bad, title: session.status.message };
    case "stopped":
      return { label: "Session deleted", className: bad, title: "The runner deleted this workspace's session" };
    default:
      return null;
  }
}

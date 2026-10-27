import { Loader2 } from "lucide-react";

import type { WorkspaceSessionState } from "../workspace-session";

/** Why the workspace's session cannot run an application, or null while it
 *  can. Shared by every Run control, so each names the same reason. */
export function sessionUnavailableReason(session: WorkspaceSessionState): string | null {
  if (session.phase === "failed") return session.problem ?? "the session could not be started";
  if (session.syncProblem) return session.syncProblem;
  if (session.status?.kind === "failed") return session.status.message;
  return null;
}

/** The workspace session's own state. Running is shown only where asked for:
 *  the Run bar says nothing while the session is simply up, the workspace-wide
 *  header always says which state it is in. */
export function SessionStatusChip({
  session,
  showRunning = false,
}: {
  session: WorkspaceSessionState;
  showRunning?: boolean;
}) {
  const described = describe(session);
  if (!described || (described.running && !showRunning)) return null;
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

function describe(session: WorkspaceSessionState): {
  label: string;
  className: string;
  title: string;
  spinning?: boolean;
  running?: boolean;
} | null {
  const neutral = "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  const bad = "bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-200";
  const good = "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200";
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
    case "running":
      return {
        label: "Session running",
        className: good,
        title: "The workspace's session is running on the runner",
        running: true,
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

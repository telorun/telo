import { Check, CircleSlash, Loader2, X } from "lucide-react";
import type { DeploymentStatus } from "../../cloud/api";
import {
  DEPLOYMENT_STATUS_LABEL,
  deploymentFinished,
  type DeploymentProgress,
} from "../../cloud/deployment-progress";

const STATUS_TONE: Record<DeploymentStatus, string> = {
  queued: "text-zinc-600 dark:text-zinc-400",
  resolving: "text-zinc-600 dark:text-zinc-400",
  applying: "text-zinc-600 dark:text-zinc-400",
  progressing: "text-zinc-600 dark:text-zinc-400",
  healthy: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400",
  canceled: "text-zinc-500 dark:text-zinc-400",
  superseded: "text-zinc-500 dark:text-zinc-400",
};

/** A deployment's status as a mark and a word; a running one turns. */
export function DeploymentStatusMark({ status }: { status: DeploymentStatus }) {
  const Icon =
    status === "healthy"
      ? Check
      : status === "failed"
        ? X
        : deploymentFinished(status)
          ? CircleSlash
          : Loader2;
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${STATUS_TONE[status]}`}>
      <Icon className={`size-3.5 ${Icon === Loader2 ? "animate-spin" : ""}`} />
      {DEPLOYMENT_STATUS_LABEL[status]}
    </span>
  );
}

function timeOf(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}

/** One deployment as it goes: its status, the steps Cloud reported and, when
 *  it failed, why — in Cloud's own words. */
export function DeploymentProgressView({ progress }: { progress: DeploymentProgress }) {
  const { deployment, events, error, retrying } = progress;
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  const stale = retrying && (
    <p className="text-xs text-amber-700 dark:text-amber-300">{retrying} Trying again…</p>
  );
  if (!deployment) {
    return stale || <p className="text-sm text-muted-foreground">Reading the deployment…</p>;
  }
  return (
    <div className="space-y-2 text-sm">
      {stale}
      <div className="flex items-center gap-2">
        <DeploymentStatusMark status={deployment.status} />
        <span className="text-muted-foreground">version {deployment.source.version}</span>
      </div>
      {events.length > 0 && (
        <ol className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
          {events.map((event) => (
            <li key={event.seq} className="flex gap-2">
              <span className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">
                {timeOf(event.at)}
              </span>
              <span className="min-w-0 wrap-anywhere">{event.message}</span>
            </li>
          ))}
        </ol>
      )}
      {deployment.error && (
        <div className="space-y-1">
          <p className="text-destructive">{deployment.error.message}</p>
          {deployment.error.detail && (
            <p className="wrap-anywhere font-mono text-xs text-muted-foreground">
              {deployment.error.detail}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{deployment.error.code}</p>
        </div>
      )}
    </div>
  );
}

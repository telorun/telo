import { useState } from "react";
import { Button } from "../../components/ui/button";
import type { AvailabilityAction } from "../types";

interface Props {
  adapterDisplayName: string;
  message: string;
  remediation?: string;
  /** Adapter-provided remedy (e.g. starting the editor-managed local runner).
   *  Its `description` states the consequences and is shown before the button. */
  action?: AvailabilityAction;
  onRecheck?: () => Promise<void>;
  onClose: () => void;
}

export function AdapterUnavailable({
  adapterDisplayName,
  message,
  remediation,
  action,
  onRecheck,
  onClose,
}: Props) {
  const [rechecking, setRechecking] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleRecheck() {
    if (!onRecheck) return;
    setRechecking(true);
    setActionError(null);
    try {
      await onRecheck();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRechecking(false);
    }
  }

  async function handleAction() {
    if (!action) return;
    setActionRunning(true);
    setActionError(null);
    try {
      await action.run();
      // Success flows back through the caller's recheck — for the run banner
      // that re-probes and restarts the interrupted run.
      await onRecheck?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionRunning(false);
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 p-6 text-center dark:bg-zinc-900">
      <div className="max-w-md">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {adapterDisplayName}
        </p>
        <p className="mt-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">{message}</p>
        {remediation && (
          <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">{remediation}</p>
        )}
        {action && (
          <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">{action.description}</p>
        )}
        {actionError && (
          <p className="mt-2 whitespace-pre-wrap break-words text-left font-mono text-xs text-red-600 dark:text-red-400">
            {actionError}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        {action && (
          <Button size="sm" onClick={handleAction} disabled={actionRunning || rechecking}>
            {actionRunning ? "Starting…" : action.label}
          </Button>
        )}
        {onRecheck && (
          <Button
            size="sm"
            variant={action ? "outline" : "default"}
            onClick={handleRecheck}
            disabled={rechecking || actionRunning}
          >
            {rechecking ? "Checking…" : "Recheck"}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

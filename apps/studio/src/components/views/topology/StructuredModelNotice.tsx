import { Code, TriangleAlert } from "lucide-react";
import type { ViewModelStatus } from "../../../language/view-model-store";
import { Button } from "../../ui/button";

/**
 * What the canvas shows while the module's view model is not ready: still
 * being read, not analysed, served by an engine that predates structured
 * editing, or failed with its reason.
 */
export function StructuredModelNotice({
  status,
  onOpenSource,
  onRetry,
}: {
  status: Exclude<ViewModelStatus, { state: "ready" }>;
  onOpenSource: () => void;
  onRetry?: () => void;
}) {
  if (status.state === "loading" || status.state === "absent") {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-1 bg-zinc-50 px-6 text-center dark:bg-zinc-900">
        <span className="text-sm text-zinc-400 dark:text-zinc-600">Analyzing module…</span>
        {status.state === "absent" && (
          <span className="max-w-sm text-xs text-zinc-400 dark:text-zinc-600">
            The language engine is not analysing this module yet.
          </span>
        )}
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="flex h-full flex-1 flex-col items-center justify-center gap-2 bg-zinc-50 px-6 text-center dark:bg-zinc-900"
    >
      <TriangleAlert className="size-5 shrink-0 text-amber-500" />
      {status.state === "unsupported" ? (
        <>
          <p className="max-w-md text-sm text-zinc-700 dark:text-zinc-300">
            {status.version ? `Telo ${status.version}` : "The telo version this module is edited against"}{" "}
            predates structured editing — edit this module in the source view.
          </p>
          <Button variant="outline" size="sm" onClick={onOpenSource}>
            <Code />
            Open source view
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            The module's structure could not be read
          </p>
          <p className="max-w-md font-mono text-xs break-words text-zinc-500">{status.error}</p>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
        </>
      )}
    </div>
  );
}

import { Button } from "../../components/ui/button";
import { useRun } from "../context";
import { AdapterUnavailable } from "./AdapterUnavailable";
import { LogStream } from "./LogStream";
import { RunStatusChip } from "./RunStatusChip";

/** Full-canvas replacement shown while a run is active (or an
 *  unavailable/setup-required message needs surfacing). Renders in place of
 *  the normal view multiplexer; closing it returns to the previous view. */
export function RunView() {
  const {
    activeRun,
    unavailableRun,
    stopRun,
    clearLog,
    closeRunView,
  } = useRun();

  if (unavailableRun && !activeRun) {
    return (
      <AdapterUnavailable
        adapterDisplayName={unavailableRun.adapterDisplayName}
        message={unavailableRun.message}
        remediation={unavailableRun.remediation}
        onRecheck={unavailableRun.recheck}
        onClose={closeRunView}
      />
    );
  }

  if (!activeRun) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-400 dark:text-zinc-600">
        No active run.
      </div>
    );
  }

  const isRunning =
    activeRun.status.kind === "starting" || activeRun.status.kind === "running";

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-950">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
          {activeRun.adapterDisplayName}
        </span>
        <RunStatusChip status={activeRun.status} />
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={stopRun} disabled={!isRunning}>
          Stop
        </Button>
        <Button size="sm" variant="ghost" onClick={clearLog} disabled={isRunning}>
          Clear
        </Button>
        <Button size="sm" variant="ghost" onClick={closeRunView}>
          ×
        </Button>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <LogStream lines={activeRun.lines} truncated={activeRun.truncated} />
      </div>
    </div>
  );
}

import { ChevronDown, PanelBottom, Play, Server, Square } from "lucide-react";

import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useRun } from "../context";
import { isTerminal } from "../types";
import { RunStatusChip } from "./RunStatusChip";
import { useElapsed } from "./use-elapsed";

interface RunBarProps {
  /** The Application this pane runs. */
  appPath: string;
  /** Active runner from settings, or null when none is selected. */
  runnerName: string | null;
  /** Start this Application. There is one way to run, so there is one control:
   *  whether the session also reloads on save is the runner's capability to
   *  answer, not a mode the user picks. */
  onRun: () => void;
  onOpenSettings: () => void;
}

/** Run controls, docked at the right end of the module's own view-tab strip: the
 *  runner that will host the run, the trigger, the live status, and the toggle
 *  for the output dock. Living in this strip is the point — it is the module's
 *  scope, and it already holds the Variables tab that configures the run. The
 *  environment is NOT named here: there is exactly one per Application, so a
 *  chip for it mimicked a selector over a constant. */
export function RunBar({
  appPath,
  runnerName,
  onRun,
  onOpenSettings,
}: RunBarProps) {
  const {
    runsForApp,
    liveRunForApp,
    selectedRunForApp,
    isStartingApp,
    blockerForApp,
    stopRun,
    selectRun,
    clearRunsForApp,
    dockForApp,
    dockHasContent,
    setDockOpen,
  } = useRun();

  const runs = runsForApp(appPath);
  const liveRun = liveRunForApp(appPath);
  const shownRun = selectedRunForApp(appPath);
  const dock = dockForApp(appPath);
  const starting = isStartingApp(appPath);
  const blocker = blockerForApp(appPath);
  const elapsed = useElapsed(liveRun?.startedAt ?? null);
  const hasHistory = runs.some((r) => isTerminal(r.status));
  const hasOutput = dockHasContent(appPath);

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onOpenSettings}
        title={runnerName ? `Runner: ${runnerName}` : "No runner selected"}
        className="flex max-w-40 items-center gap-1 truncate rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        <Server className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{runnerName ?? "No runner"}</span>
      </button>

      <div className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-800" aria-hidden />

      {liveRun ? (
        <>
          <RunStatusChip status={liveRun.status} />
          {elapsed && (
            <span className="tabular-nums text-xs text-zinc-500 dark:text-zinc-400">{elapsed}</span>
          )}
        </>
      ) : (
        shownRun && <RunStatusChip status={shownRun.status} />
      )}

      {hasOutput && (
        <Button
          variant={dock.open ? "secondary" : "ghost"}
          size="icon-xs"
          onClick={() => setDockOpen(appPath, !dock.open)}
          title={dock.open ? "Hide output" : "Show output"}
          aria-label={dock.open ? "Hide output" : "Show output"}
        >
          <PanelBottom />
        </Button>
      )}

      <div className="flex items-stretch">
        {liveRun ? (
          <Button
            variant="default"
            size="xs"
            className="rounded-r-none"
            onClick={() => void stopRun(liveRun.id)}
          >
            <Square className="size-2.5 fill-current" aria-hidden />
            Stop
          </Button>
        ) : (
          <Button
            variant="default"
            size="xs"
            className="rounded-r-none"
            onClick={onRun}
            disabled={starting}
          >
            <Play className="size-2.5 fill-current" aria-hidden />
            Run
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="default"
              size="icon-xs"
              className="rounded-l-none border-l border-l-black/15 dark:border-l-white/15"
              aria-label="Recent runs"
              title="Recent runs"
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="flex items-center justify-between gap-2">
              Recent runs
              {hasHistory && (
                <button
                  type="button"
                  onClick={() => clearRunsForApp(appPath)}
                  className="font-normal text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  Clear
                </button>
              )}
            </DropdownMenuLabel>
            {runs.length === 0 ? (
              <DropdownMenuItem disabled>No runs yet</DropdownMenuItem>
            ) : (
              runs.map((run) => (
                <DropdownMenuItem
                  key={run.id}
                  onSelect={() => selectRun(run.id)}
                  className="justify-between gap-3"
                >
                  <span className="truncate tabular-nums">
                    {new Date(run.startedAt).toLocaleTimeString()}
                  </span>
                  <RunStatusChip status={run.status} />
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

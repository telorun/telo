import { ChevronDown, Monitor, Moon, Redo2, Square, Sun, Undo2 } from "lucide-react";
import type { ParsedManifest, Workspace } from "../model";
import { type ThemePreference, useColorModeControls } from "../theme/color-mode";
import { getModuleFiles, summarizeFiles } from "../diagnostics-aggregate";
import type { RunRecord, RunStatus } from "../run";
import { RunStatusChip } from "../run";
import { DiagnosticBadge } from "./diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "./diagnostics/DiagnosticsContext";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

function formatRunTime(startedAt: number): string {
  return new Date(startedAt).toLocaleTimeString();
}

interface TopBarProps {
  workspace: Workspace | null;
  activeManifest: ParsedManifest | null;
  onOpen: () => void;
  onOpenSettings: () => void;
  onRun?: () => void;
  /** Status of the active Application's live (or most recent) run, or null.
   *  Drives the Run button's spinner (in-flight) / dot (terminal). */
  runStatus?: RunStatus | null;
  /** Newest-first run history for the active Application — shown in the Run
   *  button's chevron dropdown. */
  runs?: RunRecord[];
  /** Open the output view for a past/selected run. */
  onSelectRun?: (runId: string) => void;
  /** Stop the active Application's live run — the Stop button shown beside Run
   *  while a run is in flight. */
  onStop?: (runId: string) => void;
  /** Clear the active Application's finished run history (the dropdown's Clear). */
  onClearRuns?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

export function TopBar({
  workspace,
  activeManifest,
  onOpen,
  onOpenSettings,
  onRun,
  runStatus,
  runs = [],
  onSelectRun,
  onStop,
  onClearRuns,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: TopBarProps) {
  const label = activeManifest?.metadata.name ?? (workspace ? "(no module selected)" : "");
  const diagState = useDiagnosticsState();
  const topBarSummary = activeManifest
    ? summarizeFiles(diagState, getModuleFiles(activeManifest))
    : null;
  const canRun = activeManifest?.kind === "Application";
  const runTerminal =
    runStatus?.kind === "exited" || runStatus?.kind === "failed" || runStatus?.kind === "stopped";
  const runTerminalOk = runStatus?.kind === "exited" && runStatus.code === 0;
  const liveRun =
    runs.find((r) => r.status.kind === "starting" || r.status.kind === "running") ?? null;
  const hasHistory = runs.some(
    (r) => r.status.kind === "exited" || r.status.kind === "failed" || r.status.kind === "stopped",
  );

  return (
    <div className="flex h-10 items-center border-b border-zinc-200 bg-white px-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <span className="font-semibold text-zinc-900 dark:text-zinc-100">Telo Editor</span>

      <div className="mx-4 flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-zinc-500 dark:text-zinc-400">
        {workspace && (
          <>
            <span className="truncate text-zinc-700 dark:text-zinc-300">{label}</span>
            <DiagnosticBadge summary={topBarSummary} size="sm" stopPropagation={false} />
          </>
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onOpen}>
          Open workspace
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo"
          aria-label="Undo"
        >
          <Undo2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo"
          aria-label="Redo"
        >
          <Redo2 />
        </Button>
        <Button variant="ghost" size="sm" disabled>
          Save
        </Button>
        <div className="flex items-stretch">
          {liveRun ? (
            <Button
              variant="default"
              size="sm"
              className="rounded-r-none"
              onClick={() => onStop?.(liveRun.id)}
            >
              <Square className="size-3 fill-current" aria-hidden />
              Stop
            </Button>
          ) : (
            <Button
              variant={canRun ? "default" : "ghost"}
              size="sm"
              className="rounded-r-none"
              onClick={canRun ? onRun : undefined}
              disabled={!canRun}
            >
              {runTerminal ? (
                <span
                  className={`mr-1 inline-block h-2 w-2 rounded-full ${
                    runTerminalOk ? "bg-green-500" : "bg-red-500"
                  }`}
                  aria-hidden
                />
              ) : null}
              Run
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={canRun ? "default" : "ghost"}
                size="icon-sm"
                className="rounded-l-none border-l border-l-black/15 dark:border-l-white/15"
                disabled={!canRun && runs.length === 0}
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
                    onClick={onClearRuns}
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
                    onSelect={() => onSelectRun?.(run.id)}
                    className="justify-between gap-3"
                  >
                    <span className="truncate tabular-nums">{formatRunTime(run.startedAt)}</span>
                    <RunStatusChip status={run.status} />
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <ThemeToggleButton />
        <Button variant="ghost" size="sm" onClick={onOpenSettings}>
          Settings
        </Button>
      </div>
    </div>
  );
}

const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};
const PREFERENCE_ICON: Record<ThemePreference, typeof Monitor> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/** Cycles the editor's color mode: system → light → dark. */
function ThemeToggleButton() {
  const { preference, setPreference } = useColorModeControls();
  const Icon = PREFERENCE_ICON[preference];
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => setPreference(NEXT_PREFERENCE[preference])}
      title={`Theme: ${preference} (click to change)`}
      aria-label={`Theme: ${preference}`}
    >
      <Icon />
    </Button>
  );
}

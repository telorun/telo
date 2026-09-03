import { Bug, ChevronDown, ChevronUp, Maximize2, Minimize2, Play, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { RUN_DOCK_MIN_HEIGHT, useRun } from "../context";
import type { RunRecord } from "../context";
import { RunOutput } from "./RunOutput";
import { RunStatusChip } from "./RunStatusChip";
import { useElapsed } from "./use-elapsed";

/** Vertical space the views above keep while the dock is dragged. */
const MIN_VIEW_HEIGHT = 120;

interface RunDockProps {
  /** The Application whose runs this dock shows. */
  appPath: string;
  /** Switch the module pane to its Variables tab — where a blocker's fix lives. */
  onOpenConfig: () => void;
}

/** Output dock for one Application, pinned to the bottom of that module's pane.
 *  It sits UNDER the module's view tabs rather than over them, which is what
 *  keeps a run legible as this application running instead of a mode the window
 *  entered. Renders nothing until the app has something to show. */
export function RunDock({ appPath, onOpenConfig }: RunDockProps) {
  const {
    selectedRunForApp,
    liveRunForApp,
    blockerForApp,
    isStartingApp,
    dockForApp,
    dockHasContent,
    setDockOpen,
    setDockHeight,
    setDockMaximized,
  } = useRun();

  const run = selectedRunForApp(appPath);
  const live = liveRunForApp(appPath);
  const blocker = blockerForApp(appPath);
  const starting = isStartingApp(appPath);
  const dock = dockForApp(appPath);
  const elapsed = useElapsed(live?.startedAt ?? null);

  const frame = useRef<HTMLDivElement | null>(null);
  const dragFrom = useRef<{ y: number; height: number } | null>(null);
  // The in-flight height lives HERE, not in the run context. Committing per
  // pointer-move rebuilt the context value, so every `useRun()` consumer —
  // Editor, the whole module pane, and each row of the module tree — re-rendered
  // on every pixel of a drag. The context learns the height once, at the end.
  const [draftHeight, setDraftHeight] = useState<number | null>(null);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const from = dragFrom.current;
    if (!from) return;
    // Dragging the handle UP grows the dock, so the delta is inverted. The
    // views above keep a strip of their own — a dock dragged past the pane
    // would push them out of existence with no way to drag it back.
    const pane = frame.current?.parentElement?.getBoundingClientRect().height;
    const max = pane ? Math.max(RUN_DOCK_MIN_HEIGHT, pane - MIN_VIEW_HEIGHT) : Infinity;
    const next = Math.min(max, Math.max(RUN_DOCK_MIN_HEIGHT, from.height + (from.y - event.clientY)));
    setDraftHeight(next);
  }, []);

  const endDragRef = useRef<() => void>(() => undefined);
  const endDrag = useCallback(() => {
    const from = dragFrom.current;
    dragFrom.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", endDragRef.current);
    if (!from) return;
    setDraftHeight((height) => {
      if (height !== null) setDockHeight(appPath, height);
      return null;
    });
  }, [appPath, handlePointerMove, setDockHeight]);
  endDragRef.current = endDrag;

  const startDrag = useCallback(
    (event: React.PointerEvent) => {
      if (dock.maximized) return;
      event.preventDefault();
      dragFrom.current = { y: event.clientY, height: dock.height };
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", endDragRef.current);
    },
    [dock.height, dock.maximized, handlePointerMove],
  );

  // A drag survives its component otherwise: unmounting mid-drag (switching
  // modules, closing the tab) left both listeners on `window` until the next
  // pointerup anywhere.
  useEffect(() => () => endDragRef.current(), []);

  if (!dockHasContent(appPath)) return null;

  const headline = blocker
    ? blocker.kind === "missing-config"
      ? "Missing required configuration"
      : blocker.adapterDisplayName
    : starting
      ? "Starting run…"
      : (run?.adapterDisplayName ?? "");

  if (!dock.open) {
    return (
      <button
        type="button"
        onClick={() => setDockOpen(appPath, true)}
        className="flex h-7 shrink-0 items-center gap-2 border-t border-zinc-200 bg-white px-3 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        <ChevronUp className="size-3" aria-hidden />
        <span className="font-medium">{headline}</span>
        {run && !blocker && !starting && <RunStatusChip status={run.status} />}
        {elapsed && <span className="tabular-nums text-zinc-500">{elapsed}</span>}
        <span className="flex-1" />
        <span className="text-zinc-400 dark:text-zinc-500">Show output</span>
      </button>
    );
  }

  return (
    <div
      ref={frame}
      className={`flex shrink-0 flex-col overflow-hidden border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 ${
        dock.maximized ? "flex-1" : ""
      }`}
      style={
        dock.maximized
          ? undefined
          : { height: Math.max(RUN_DOCK_MIN_HEIGHT, draftHeight ?? dock.height) }
      }
    >
      <div
        onPointerDown={startDrag}
        className={`h-1 shrink-0 ${dock.maximized ? "" : "cursor-row-resize hover:bg-blue-400/60"}`}
        aria-hidden
      />
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{headline}</span>
        {run && !blocker && !starting && <RunStatusChip status={run.status} />}
        {elapsed && (
          <span className="tabular-nums text-xs text-zinc-500 dark:text-zinc-400">{elapsed}</span>
        )}
        {run?.status.kind === "running" && run.status.inspectUrl && (
          <a
            href={run.status.inspectUrl}
            target="_blank"
            rel="noreferrer"
            title="Open inspection UI"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <Bug size={13} aria-hidden />
            Inspect
          </a>
        )}
        {run?.status.kind === "starting" && run.progress && (
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {run.progress.message}
          </span>
        )}
        {run && <RunGenerations runs={run.runs} />}
        <div className="flex-1" />
        {run && <WatchControls run={run} />}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setDockMaximized(appPath, !dock.maximized)}
          title={dock.maximized ? "Restore" : "Maximize"}
          aria-label={dock.maximized ? "Restore output" : "Maximize output"}
        >
          {dock.maximized ? <Minimize2 /> : <Maximize2 />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setDockOpen(appPath, false)}
          title="Hide output"
          aria-label="Hide output"
        >
          <ChevronDown />
        </Button>
      </div>
      <RunOutput appPath={appPath} onOpenConfig={onOpenConfig} />
    </div>
  );
}

/**
 * The latest run outcome per application — deliberately separate from the
 * session status chip beside it. A one-shot app completing in a watch session
 * leaves the session `running`, so "the session is up" and "the last run
 * succeeded" are two different facts and are shown as two.
 */
function RunGenerations({ runs }: { runs: RunRecord["runs"] }) {
  const entries = Object.values(runs);
  if (entries.length === 0) return null;
  return (
    <span className="flex items-center gap-2">
      {entries.map((run) => (
        <span
          key={run.app}
          className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-zinc-500 dark:text-zinc-400"
          title={
            run.phase === "failed"
              ? run.reason
              : run.phase === "completed"
                ? `exit ${run.code}`
                : `started by ${run.trigger}`
          }
        >
          {entries.length > 1 && (
            <span className="font-medium text-zinc-600 dark:text-zinc-300">{run.app}</span>
          )}
          <span className="tabular-nums">#{run.generation}</span>
          <span
            className={
              run.phase === "failed"
                ? "text-red-600 dark:text-red-400"
                : run.phase === "completed"
                  ? run.code === 0
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
                  : "text-blue-600 dark:text-blue-400"
            }
          >
            {run.phase === "started"
              ? run.trigger === "watch"
                ? "reloading"
                : "running"
              : run.phase === "completed"
                ? `exit ${run.code}`
                : "failed"}
          </span>
        </span>
      ))}
    </span>
  );
}

/** Reload and Resume — the two things a watch session can do that a run session
 *  cannot. Both are absent on a run session, where the session IS the run. */
function WatchControls({ run }: { run: RunRecord }) {
  const { reloadRun, resumeRun } = useRun();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const act = (work: Promise<void>): void => {
    setBusy(true);
    setProblem(null);
    void work
      .catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const note = problem ? (
    <span className="max-w-64 truncate text-[11px] text-red-600 dark:text-red-400" title={problem}>
      {problem}
    </span>
  ) : null;

  if (run.status.kind === "suspended") {
    return (
      <>
        {note}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          title="The session was reaped for idleness; its workspace checkpoint is held"
          onClick={() =>
            act(
              resumeRun(run.id).then((resumed) => {
                // The checkpoint lives in the runner's memory, so a restart loses
                // it. Saying so is the whole remedy the design relies on: the
                // editor holds the authoritative workspace and re-runs to re-seed.
                if (!resumed) {
                  throw new Error(
                    "The runner no longer holds this session — run it again to start a fresh one.",
                  );
                }
              }),
            )
          }
        >
          <Play size={13} aria-hidden />
          Resume
        </Button>
      </>
    );
  }

  // `runs` is populated only by a session that reports run outcomes — a watch
  // session. A run session never shows these.
  if (run.status.kind !== "running" || Object.keys(run.runs).length === 0) return null;

  return (
    <>
      {note}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        title="Re-run with no file change"
        onClick={() => act(reloadRun(run.id))}
      >
        <RotateCw size={13} aria-hidden />
        Reload
      </Button>
    </>
  );
}

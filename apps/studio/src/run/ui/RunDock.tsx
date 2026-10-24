import {
  Bug,
  ChevronDown,
  ChevronUp,
  Clock,
  KeyRound,
  Maximize2,
  Minimize2,
  RotateCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { RUN_DOCK_MIN_HEIGHT, useRun } from "../context";
import type { RunBlocker, RunRecord } from "../context";
import type { RunWait, WorkspaceSessionState } from "../workspace-session";
import { RunOutput } from "./RunOutput";
import { RunStatusChip } from "./RunStatusChip";
import { describeTeloAlignment, staleRunVersion, teloAlignment } from "../telo-alignment";
import { useElapsed } from "./use-elapsed";
import { explainRunFailurePrompt, useAgentCompose } from "../../agent";
import { FAILURE_OUTPUT_CHARS, describeRunFailure, outputTail } from "../run-failure";

/** Vertical space the views above keep while the dock is dragged. */
const MIN_VIEW_HEIGHT = 120;

interface RunDockProps {
  /** The Application whose runs this dock shows. */
  appPath: string;
  /** That Application's name, for a question put to the agent about its run. */
  appName?: string;
  /** The telo version that Application's module is edited against right now. */
  editedTelo?: string;
  /** Switch the module pane to its Variables tab — where a blocker's fix lives. */
  onOpenConfig: () => void;
}

/** Output dock for one Application, pinned to the bottom of that module's pane.
 *  It sits UNDER the module's view tabs rather than over them, which is what
 *  keeps a run legible as this application running instead of a mode the window
 *  entered. Renders nothing until the app has something to show. */
export function RunDock({ appPath, appName, editedTelo, onOpenConfig }: RunDockProps) {
  const {
    selectedRunForApp,
    liveRunForApp,
    blockerForApp,
    dockForApp,
    dockHasContent,
    setDockOpen,
    setDockHeight,
    setDockMaximized,
    getTerminal,
    session,
    appNameOf,
  } = useRun();
  const agentCompose = useAgentCompose();

  const run = selectedRunForApp(appPath);
  const live = liveRunForApp(appPath);
  const blocker = blockerForApp(appPath);
  const sessionApp = appNameOf(appPath);
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

  const failure = run && !blocker ? describeRunFailure(run) : null;
  const explainFailure =
    run && failure && agentCompose
      ? () => {
          const output = getTerminal(run.id)?.tail(FAILURE_OUTPUT_CHARS * 4) ?? "";
          agentCompose.compose(
            explainRunFailurePrompt({
              application: appName ?? agentCompose.workspaceFile(appPath),
              file: agentCompose.workspaceFile(appPath),
              failure,
              output: outputTail(output),
            }),
          );
        }
      : null;

  const headline = blocker ? blockerHeadline(blocker) : (run?.runnerName ?? "");
  const wait = run?.status.kind === "queued" && session ? session.waiting.get(run.app) : undefined;
  const inspectUrl = run?.status.kind === "running" ? session?.inspectUrl : null;

  if (!dock.open) {
    return (
      <button
        type="button"
        onClick={() => setDockOpen(appPath, true)}
        className="flex h-7 shrink-0 items-center gap-2 border-t border-zinc-200 bg-white px-3 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        <ChevronUp className="size-3" aria-hidden />
        <span className="font-medium">{headline}</span>
        {run && !blocker && <RunStatusChip status={run.status} />}
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
      {/* Wraps: a pane too narrow for one row gives the facts and the actions
          rows of their own instead of pushing the actions off the pane. */}
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-zinc-200 px-3 py-1 dark:border-zinc-800">
        <span className="whitespace-nowrap text-xs font-medium text-zinc-600 dark:text-zinc-300">
          {headline}
        </span>
        {run && !blocker && <RunStatusChip status={run.status} />}
        {elapsed && (
          <span className="tabular-nums text-xs text-zinc-500 dark:text-zinc-400">{elapsed}</span>
        )}
        {inspectUrl && (
          <a
            href={inspectUrl}
            target="_blank"
            rel="noreferrer"
            title="Open inspection UI"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <Bug size={13} aria-hidden />
            Inspect
          </a>
        )}
        {wait && session && <RunWaitNote wait={wait} session={session} />}
        {(run?.status.kind === "starting" || run?.status.kind === "queued") && run.progress && (
          <span className="min-w-0 truncate text-xs text-zinc-500 dark:text-zinc-400">
            {run.progress.message}
          </span>
        )}
        {session && sessionApp !== null && <AppSetNote session={session} />}
        {session && <CredentialNote session={session} />}
        {run && <RunGenerations runs={run.runs} />}
        {run && <RunTeloVersions run={run} />}
        {run && <StaleRunVersion run={run} editedTelo={editedTelo} />}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {explainFailure && (
            <Button size="sm" variant="ghost" onClick={explainFailure} title="Ask the agent to explain this failure">
              <Sparkles size={13} aria-hidden />
              Explain this failure
            </Button>
          )}
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
      </div>
      <RunOutput appPath={appPath} onOpenConfig={onOpenConfig} />
    </div>
  );
}

/** What the dock's header says about a run that never started. */
function blockerHeadline(blocker: RunBlocker): string {
  switch (blocker.kind) {
    case "missing-config":
      return "Missing required configuration";
    case "env-files":
      return "The env files could not be read";
    case "outside-workspace":
      return "A file outside the workspace";
    case "unavailable":
      return blocker.adapterDisplayName;
  }
}

/** Why a Run has not started yet. */
function RunWaitNote({ wait, session }: { wait: RunWait; session: WorkspaceSessionState }) {
  const text =
    wait === "session"
      ? session.status?.kind === "suspended" || session.status?.kind === "failed"
        ? "Resuming the workspace's session…"
        : "Waiting for the workspace's session…"
      : wait === "turn"
        ? "Not in the session yet: it is added when the agent's turn ends, then this run starts."
        : wait === "app-set"
          ? "Not in the session yet: it runs once the session's applications are updated."
          : "Waiting for the application's container…";
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400" title={text}>
      <Clock size={12} className="shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  );
}

/** Why a signed-in user's session on this runner is reached with a resume
 *  secret rather than their sign-in. */
function CredentialNote({ session }: { session: WorkspaceSessionState }) {
  const credential = session.credential;
  if (credential?.kind !== "secret" || !credential.reason) return null;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400"
      title={credential.reason}
    >
      <KeyRound size={12} className="shrink-0" aria-hidden />
      <span className="truncate">Not using your sign-in: {credential.reason}</span>
    </span>
  );
}

/** The workspace's app set while a change to it is not applied, or the runner
 *  refused it. */
function AppSetNote({ session }: { session: WorkspaceSessionState }) {
  if (session.appSet.problem) {
    return (
      <span
        role="alert"
        className="inline-flex min-w-0 items-center gap-1 text-[11px] font-medium text-red-700 dark:text-red-400"
        title={session.appSet.problem}
      >
        <TriangleAlert size={12} className="shrink-0" aria-hidden />
        <span className="truncate">The session's applications could not be updated: {session.appSet.problem}</span>
      </span>
    );
  }
  if (session.appSet.pending === "none") return null;
  const text =
    session.appSet.pending === "turn"
      ? "Application changes pending — applied when the agent's turn ends"
      : session.appSet.pending === "session"
        ? "Application changes pending — applied once the session is up"
        : "Updating the session's applications…";
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400" title={text}>
      <Clock size={12} className="shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  );
}

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

/**
 * The telo version each application runs on, as its runtime reports it, set
 * against the version this run asked for. A runtime on another version is a
 * warning and nothing more: the run goes on, and the user is told that what
 * they see was not produced by the version they selected.
 */
function RunTeloVersions({ run }: { run: RunRecord }) {
  // An app is spoken for once it has started: before that, a runtime that has
  // said nothing has simply not said it yet.
  const apps = Object.keys(run.runs);
  if (apps.length === 0) {
    if (run.requestedTelo === undefined) return null;
    return (
      <span
        className="whitespace-nowrap text-[11px] text-zinc-500 dark:text-zinc-400"
        title={`Asked to run on telo ${run.requestedTelo}.`}
      >
        telo {run.requestedTelo}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      {apps.map((app) => {
        const alignment = teloAlignment(run.requestedTelo, run.reportedTelo[app]);
        if (!alignment) return null;
        const mismatch = alignment.kind === "mismatch";
        return (
          <span
            key={app}
            role={mismatch ? "alert" : undefined}
            className={
              "inline-flex items-center gap-1 whitespace-nowrap text-[11px] " +
              (mismatch
                ? "font-medium text-amber-700 dark:text-amber-400"
                : "text-zinc-500 dark:text-zinc-400")
            }
            title={describeTeloAlignment(alignment)}
          >
            {mismatch && <TriangleAlert size={12} aria-hidden />}
            {apps.length > 1 && <span>{app}</span>}
            {alignment.kind === "mismatch"
              ? `telo ${alignment.reported}, not ${alignment.requested}`
              : alignment.kind === "unconfirmed"
                ? `telo ${alignment.requested} (not confirmed)`
                : `telo ${alignment.version}`}
          </span>
        );
      })}
    </span>
  );
}

/**
 * A live run whose module has since moved to another telo version: the editor
 * now checks against one version while the session still runs the one it was
 * started on, and each agrees with itself. Said here, because nothing else
 * would — a run's telo is fixed when its process starts.
 */
function StaleRunVersion({ run, editedTelo }: { run: RunRecord; editedTelo?: string }) {
  const stale = staleRunVersion(run.status.kind === "queued" ? "starting" : run.status.kind, run.requestedTelo, editedTelo);
  if (!stale) return null;
  return (
    <span
      role="alert"
      className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium text-amber-700 dark:text-amber-400"
      title={
        `This run was started on telo ${stale.running}, and the module is now edited against ` +
        `telo ${stale.edited}. Run again to move it to ${stale.edited}.`
      }
    >
      <TriangleAlert size={12} aria-hidden />
      edited against telo {stale.edited} — run again
    </span>
  );
}

/** Reload — re-run a live app with no file change. */
function WatchControls({ run }: { run: RunRecord }) {
  const { reloadRun } = useRun();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (run.status.kind !== "running") return null;

  const reload = (): void => {
    setBusy(true);
    setProblem(null);
    void reloadRun(run.id)
      .catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      {problem && (
        <span className="min-w-0 max-w-64 truncate text-[11px] text-red-600 dark:text-red-400" title={problem}>
          {problem}
        </span>
      )}
      <Button size="sm" variant="ghost" disabled={busy} title="Re-run with no file change" onClick={reload}>
        <RotateCw size={13} aria-hidden />
        Reload
      </Button>
    </>
  );
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  isTerminal,
  type RunAdapter,
  type RunEvent,
  type RunRequest,
  type RunSession,
  type RunStatus,
} from "./types";

const MAX_LOG_LINES = 10_000;

export interface LogLine {
  id: number;
  stream: "stdout" | "stderr";
  text: string;
}

/** What the UI sees about the currently-visible run. Lives in state; updated
 *  as events arrive from the adapter. */
export interface ActiveRun {
  sessionId: string;
  adapterId: string;
  adapterDisplayName: string;
  status: RunStatus;
  lines: LogLine[];
  truncated: boolean;
  startedAt: number;
  session: RunSession;
}

/** Unavailable/setup-required banner shown in RunView when a run failed to
 *  start because of environment or config. Not a RunSession — no events. */
export interface UnavailableRun {
  adapterId: string;
  adapterDisplayName: string;
  message: string;
  remediation?: string;
  /** Optional re-probe function so the Recheck button can retry without
   *  going back through Editor's entire Run flow. */
  recheck?: () => Promise<void>;
}

interface RunContextValue {
  activeRun: ActiveRun | null;
  unavailableRun: UnavailableRun | null;
  isRunViewOpen: boolean;
  /** True while a session is `starting` or `running` — drives the TopBar
   *  Run-button spinner. */
  isInFlight: boolean;
  /** True while `adapter.start` is awaited (before the first `activeRun`
   *  exists). Lets RunView render a loading indicator instead of the
   *  "No active run." placeholder during the handoff. */
  isStarting: boolean;
  startRun(params: {
    adapter: RunAdapter<unknown>;
    config: unknown;
    request: RunRequest;
  }): Promise<void>;
  stopRun(): Promise<void>;
  showUnavailable(run: UnavailableRun): void;
  openRunView(): void;
  closeRunView(): void;
  clearLog(): void;
}

const RunContextValue = createContext<RunContextValue | null>(null);

export function useRun(): RunContextValue {
  const ctx = useContext(RunContextValue);
  if (!ctx) throw new Error("useRun() called outside <RunProvider>");
  return ctx;
}

export function RunProvider({ children }: { children: ReactNode }) {
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [unavailableRun, setUnavailableRun] = useState<UnavailableRun | null>(null);
  const [isRunViewOpen, setIsRunViewOpen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  // Line-id counter and per-stream partial-line buffer outlive any single
  // render — pulled out into refs so they aren't re-initialised when the
  // component re-renders while the run is still streaming.
  const lineIdRef = useRef(0);
  const partialRef = useRef<{ stdout: string; stderr: string }>({ stdout: "", stderr: "" });
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const isInFlight = activeRun?.status.kind === "starting" || activeRun?.status.kind === "running";

  const closeRunView = useCallback(() => {
    setIsRunViewOpen(false);
  }, []);

  const openRunView = useCallback(() => {
    setIsRunViewOpen(true);
  }, []);

  const clearLog = useCallback(() => {
    setActiveRun((run) => (run ? { ...run, lines: [], truncated: false } : run));
  }, []);

  const showUnavailable = useCallback((run: UnavailableRun) => {
    setUnavailableRun(run);
    setIsRunViewOpen(true);
  }, []);

  const stopRun = useCallback(async () => {
    const run = activeRun;
    if (!run) return;
    if (isTerminal(run.status)) return;
    try {
      await run.session.stop();
    } catch (err) {
      // If the session rejected, the exit task may already have emitted a
      // terminal status via the subscribe channel — let that drive UI state.
      // Surface the error only if we're still non-terminal after a beat.
      console.warn("run_stop invoke failed:", err);
    }
  }, [activeRun]);

  const startRun = useCallback(
    async ({
      adapter,
      config,
      request,
    }: {
      adapter: RunAdapter<unknown>;
      config: unknown;
      request: RunRequest;
    }) => {
      // Detach from any previous session's subscription before we replace it.
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      partialRef.current = { stdout: "", stderr: "" };

      setUnavailableRun(null);
      setIsRunViewOpen(true);
      setIsStarting(true);

      let session: RunSession;
      try {
        session = await adapter.start(request, config);
      } catch (err) {
        // The view was opened eagerly so the user sees something happen on
        // click. If `start` rejects (spawn failed, listen failed, etc.) we
        // close it again so the UI doesn't freeze on "No active run." The
        // caller still sees the rejection and surfaces a banner.
        setIsStarting(false);
        setIsRunViewOpen(false);
        throw err;
      }

      setActiveRun({
        sessionId: session.id,
        adapterId: adapter.id,
        adapterDisplayName: adapter.displayName,
        status: session.getStatus(),
        lines: [],
        truncated: false,
        startedAt: Date.now(),
        session,
      });
      setIsStarting(false);

      unsubscribeRef.current = session.subscribe((event) => {
        handleRunEvent(event, session.id, setActiveRun, lineIdRef, partialRef);
      });
    },
    [],
  );

  // On unmount / provider teardown, detach from any active session so we
  // don't leak listeners when the whole editor is closed.
  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, []);

  const value = useMemo<RunContextValue>(
    () => ({
      activeRun,
      unavailableRun,
      isRunViewOpen,
      isInFlight,
      isStarting,
      startRun,
      stopRun,
      showUnavailable,
      openRunView,
      closeRunView,
      clearLog,
    }),
    [
      activeRun,
      unavailableRun,
      isRunViewOpen,
      isInFlight,
      isStarting,
      startRun,
      stopRun,
      showUnavailable,
      openRunView,
      closeRunView,
      clearLog,
    ],
  );

  return <RunContextValue.Provider value={value}>{children}</RunContextValue.Provider>;
}

function handleRunEvent(
  event: RunEvent,
  sessionId: string,
  setActiveRun: React.Dispatch<React.SetStateAction<ActiveRun | null>>,
  lineIdRef: React.MutableRefObject<number>,
  partialRef: React.MutableRefObject<{ stdout: string; stderr: string }>,
) {
  if (event.type === "status") {
    setActiveRun((run) => {
      if (!run || run.sessionId !== sessionId) return run;
      return { ...run, status: event.status };
    });
    return;
  }

  // stdout/stderr: split chunk into lines, carrying a partial line forward.
  const chunk = event.chunk;
  const stream = event.type;
  const pending = partialRef.current[stream] + chunk;
  const parts = pending.split("\n");
  const nextPartial = parts.pop() ?? "";
  partialRef.current[stream] = nextPartial;

  if (parts.length === 0) return;

  const newLines: LogLine[] = parts.map((text) => ({
    id: ++lineIdRef.current,
    stream,
    text,
  }));

  setActiveRun((run) => {
    if (!run || run.sessionId !== sessionId) return run;
    const combined = [...run.lines, ...newLines];
    if (combined.length <= MAX_LOG_LINES) {
      return { ...run, lines: combined };
    }
    const overflow = combined.length - MAX_LOG_LINES;
    return {
      ...run,
      lines: combined.slice(overflow),
      truncated: true,
    };
  });
}


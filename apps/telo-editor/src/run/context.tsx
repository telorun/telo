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

import { TerminalBuffer } from "./terminal-buffer";
import {
  isTerminal,
  type RunAdapter,
  type RunEvent,
  type RunPhase,
  type RunRequest,
  type RunSession,
  type RunStatus,
} from "./types";

const MAX_LOG_LINES = 10_000;
/** Per-application run history cap. Oldest runs beyond this are evicted and
 *  their runtime (session + transcript) torn down. */
const MAX_RUNS_PER_APP = 10;

export interface LogLine {
  id: number;
  stream: "stdout" | "stderr";
  text: string;
}

/** One run of one Application — the display-facing record held in React state,
 *  newest-first within its app's list. Live runtime objects (session, terminal
 *  buffer, event subscription) live in a ref-held side table keyed by `id`, so
 *  high-frequency byte output never churns React state. */
export interface RunRecord {
  id: string;
  /** Application module `filePath` this run belongs to. */
  appPath: string;
  adapterId: string;
  adapterDisplayName: string;
  status: RunStatus;
  startedAt: number;
  /** True when this run streams a PTY transcript (terminal adapter). The
   *  TerminalBuffer itself is in the runtime side table — read via
   *  `getTerminal(id)`. */
  hasTerminal: boolean;
  /** Latest coming-up progress (build/provision/boot) while the session is
   *  still `starting`. Cleared once status reaches `running` or terminal. */
  progress: { phase: RunPhase; message: string } | null;
  /** Captured output for log-only adapters (no `io` channel). */
  lines: LogLine[];
  truncated: boolean;
}

/** Unavailable/setup-required banner shown in RunView when a run failed to
 *  start because of environment or config. Not a run — no record, no events. */
export interface UnavailableRun {
  adapterId: string;
  adapterDisplayName: string;
  message: string;
  remediation?: string;
  /** Optional re-probe so the Recheck button can retry without going back
   *  through Editor's entire Run flow. */
  recheck?: () => Promise<void>;
}

/** Live, non-serializable run state, kept out of React state. */
interface RunRuntime {
  session: RunSession;
  terminal: TerminalBuffer | null;
  unsubscribe: () => void;
  lineId: number;
  partial: { stdout: string; stderr: string };
}

interface RunContextValue {
  /** The run RunView currently shows, or null. */
  selectedRun: RunRecord | null;
  unavailableRun: UnavailableRun | null;
  isRunViewOpen: boolean;
  /** True while `adapter.start` is awaited — RunView shows a loading state. */
  isStarting: boolean;

  startRun(params: {
    appPath: string;
    adapter: RunAdapter<unknown>;
    config: unknown;
    request: RunRequest;
  }): Promise<void>;
  stopRun(runId: string): Promise<void>;
  selectRun(runId: string): void;
  openRunView(): void;
  closeRunView(): void;
  showUnavailable(run: UnavailableRun): void;

  /** Newest-first run history for one Application. */
  runsForApp(appPath: string): RunRecord[];
  /** The app's in-flight run (starting/running), or null. */
  liveRunForApp(appPath: string): RunRecord | null;
  /** The app's most recent run regardless of status, or null. */
  latestRunForApp(appPath: string): RunRecord | null;
  /** The live terminal buffer for a run, or null (log-only / unknown run). */
  getTerminal(runId: string): TerminalBuffer | null;
}

const RunContextValue = createContext<RunContextValue | null>(null);

export function useRun(): RunContextValue {
  const ctx = useContext(RunContextValue);
  if (!ctx) throw new Error("useRun() called outside <RunProvider>");
  return ctx;
}

export function RunProvider({ children }: { children: ReactNode }) {
  const [runsByApp, setRunsByApp] = useState<Map<string, RunRecord[]>>(new Map());
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [unavailableRun, setUnavailableRun] = useState<UnavailableRun | null>(null);
  const [isRunViewOpen, setIsRunViewOpen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  // Live run objects, keyed by run id. Reconciled against `runsByApp` so a run
  // that leaves React state (eviction) has its session/transcript torn down.
  const runtimes = useRef<Map<string, RunRuntime>>(new Map());

  const disposeRuntime = useCallback((runId: string) => {
    const rt = runtimes.current.get(runId);
    if (!rt) return;
    runtimes.current.delete(runId);
    rt.unsubscribe();
    // Evicting a still-running run must not leak the underlying container.
    if (!isTerminal(rt.session.getStatus())) {
      void rt.session.stop().catch(() => undefined);
    }
    rt.terminal?.dispose();
  }, []);

  const updateRecord = useCallback(
    (runId: string, mut: (record: RunRecord) => RunRecord) => {
      setRunsByApp((prev) => {
        for (const [appPath, records] of prev) {
          const idx = records.findIndex((r) => r.id === runId);
          if (idx === -1) continue;
          const nextRecords = records.slice();
          nextRecords[idx] = mut(records[idx]);
          const next = new Map(prev);
          next.set(appPath, nextRecords);
          return next;
        }
        return prev;
      });
    },
    [],
  );

  // Tear down runtimes whose record left state (evicted past the per-app cap).
  useEffect(() => {
    const live = new Set<string>();
    for (const records of runsByApp.values()) for (const r of records) live.add(r.id);
    for (const id of [...runtimes.current.keys()]) {
      if (!live.has(id)) disposeRuntime(id);
    }
  }, [runsByApp, disposeRuntime]);

  // On provider teardown, stop every live session and detach subscriptions.
  useEffect(() => {
    const table = runtimes.current;
    return () => {
      for (const id of [...table.keys()]) disposeRuntime(id);
    };
  }, [disposeRuntime]);

  const closeRunView = useCallback(() => setIsRunViewOpen(false), []);
  const openRunView = useCallback(() => setIsRunViewOpen(true), []);

  const selectRun = useCallback((runId: string) => {
    setUnavailableRun(null);
    setSelectedRunId(runId);
    setIsRunViewOpen(true);
  }, []);

  const showUnavailable = useCallback((run: UnavailableRun) => {
    setUnavailableRun(run);
    setIsRunViewOpen(true);
  }, []);

  const stopRun = useCallback(async (runId: string) => {
    const rt = runtimes.current.get(runId);
    if (!rt) return;
    if (isTerminal(rt.session.getStatus())) return;
    try {
      await rt.session.stop();
    } catch (err) {
      // If stop rejected, the exit task may already have emitted a terminal
      // status via the subscription — let that drive UI state.
      console.warn("run_stop invoke failed:", err);
    }
  }, []);

  const startRun = useCallback(
    async ({
      appPath,
      adapter,
      config,
      request,
    }: {
      appPath: string;
      adapter: RunAdapter<unknown>;
      config: unknown;
      request: RunRequest;
    }) => {
      setUnavailableRun(null);
      setIsRunViewOpen(true);
      setIsStarting(true);

      let session: RunSession;
      try {
        session = await adapter.start(request, config);
      } catch (err) {
        // The view opened eagerly so the click feels responsive; if start
        // rejects, close it again and let the caller surface the error.
        setIsStarting(false);
        setIsRunViewOpen(false);
        throw err;
      }

      const terminal = session.io ? new TerminalBuffer(session.io) : null;
      const record: RunRecord = {
        id: session.id,
        appPath,
        adapterId: adapter.id,
        adapterDisplayName: adapter.displayName,
        status: session.getStatus(),
        startedAt: Date.now(),
        hasTerminal: terminal !== null,
        progress: null,
        lines: [],
        truncated: false,
      };

      const runtime: RunRuntime = {
        session,
        terminal,
        unsubscribe: () => undefined,
        lineId: 0,
        partial: { stdout: "", stderr: "" },
      };
      runtimes.current.set(record.id, runtime);
      runtime.unsubscribe = session.subscribe((event) => {
        applyRunEvent(event, record.id, runtime, terminal !== null, updateRecord);
      });

      setRunsByApp((prev) => {
        const next = new Map(prev);
        const combined = [record, ...(prev.get(appPath) ?? [])];
        next.set(appPath, combined.slice(0, MAX_RUNS_PER_APP));
        return next;
      });
      setSelectedRunId(record.id);
      setIsStarting(false);
    },
    [updateRecord],
  );

  const selectedRun = useMemo<RunRecord | null>(() => {
    if (!selectedRunId) return null;
    for (const records of runsByApp.values()) {
      const found = records.find((r) => r.id === selectedRunId);
      if (found) return found;
    }
    return null;
  }, [runsByApp, selectedRunId]);

  const runsForApp = useCallback(
    (appPath: string) => runsByApp.get(appPath) ?? [],
    [runsByApp],
  );
  const liveRunForApp = useCallback(
    (appPath: string) =>
      (runsByApp.get(appPath) ?? []).find(
        (r) => r.status.kind === "starting" || r.status.kind === "running",
      ) ?? null,
    [runsByApp],
  );
  const latestRunForApp = useCallback(
    (appPath: string) => (runsByApp.get(appPath) ?? [])[0] ?? null,
    [runsByApp],
  );
  const getTerminal = useCallback(
    (runId: string) => runtimes.current.get(runId)?.terminal ?? null,
    [],
  );

  const value = useMemo<RunContextValue>(
    () => ({
      selectedRun,
      unavailableRun,
      isRunViewOpen,
      isStarting,
      startRun,
      stopRun,
      selectRun,
      openRunView,
      closeRunView,
      showUnavailable,
      runsForApp,
      liveRunForApp,
      latestRunForApp,
      getTerminal,
    }),
    [
      selectedRun,
      unavailableRun,
      isRunViewOpen,
      isStarting,
      startRun,
      stopRun,
      selectRun,
      openRunView,
      closeRunView,
      showUnavailable,
      runsForApp,
      liveRunForApp,
      latestRunForApp,
      getTerminal,
    ],
  );

  return <RunContextValue.Provider value={value}>{children}</RunContextValue.Provider>;
}

function applyRunEvent(
  event: RunEvent,
  runId: string,
  runtime: RunRuntime,
  hasTerminal: boolean,
  updateRecord: (runId: string, mut: (record: RunRecord) => RunRecord) => void,
): void {
  if (event.type === "status") {
    // Reaching running/terminal ends the coming-up phase — drop the spinner feed.
    const clearProgress = event.status.kind !== "starting";
    updateRecord(runId, (record) => ({
      ...record,
      status: event.status,
      progress: clearProgress ? null : record.progress,
    }));
    return;
  }

  if (event.type === "progress") {
    updateRecord(runId, (record) =>
      // A progress frame arriving after the workload is up is stale — ignore it.
      record.status.kind === "starting"
        ? { ...record, progress: { phase: event.phase, message: event.message } }
        : record,
    );
    return;
  }

  // Terminal adapters render their bytes through the TerminalBuffer (the `io`
  // channel); their stdout/stderr events are not shown as lines, so skip them
  // to avoid duplicating output.
  if (hasTerminal) return;

  const stream = event.type;
  const pending = runtime.partial[stream] + event.chunk;
  const parts = pending.split("\n");
  runtime.partial[stream] = parts.pop() ?? "";
  if (parts.length === 0) return;

  const newLines: LogLine[] = parts.map((text) => ({
    id: ++runtime.lineId,
    stream,
    text,
  }));
  updateRecord(runId, (record) => {
    const combined = [...record.lines, ...newLines];
    if (combined.length <= MAX_LOG_LINES) return { ...record, lines: combined };
    const overflow = combined.length - MAX_LOG_LINES;
    return { ...record, lines: combined.slice(overflow), truncated: true };
  });
}

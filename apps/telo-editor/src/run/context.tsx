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

import { type DebugFrame, isLogFrame } from "@telorun/debug-wire";

import { registry } from "./registry";
import { loadRunIndex, saveRunIndex, type PersistedRunEntry } from "./run-index";
import { TerminalBuffer } from "./terminal-buffer";
import {
  isTerminal,
  type RunAdapter,
  type RunEvent,
  type RunPhase,
  type RunReachabilityState,
  type RunRequest,
  type RunSession,
  type RunStatus,
} from "./types";

const MAX_LOG_LINES = 10_000;
/** Ring cap on buffered debug frames (events + log lines) held per run. */
const MAX_DEBUG_FRAMES = 5_000;
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
  /** Frames from the workload's kernel debug stream (events + log lines), fed
   *  to the Debug panel's Logs / Events tabs. Newest appended; capped. */
  debugFrames: DebugFrame[];
  /** Total frames ever appended (incl. evicted ones). Monotonic — the sequence
   *  of `debugFrames[0]` is `debugFrameSeq - debugFrames.length`. Lets the view
   *  track a "cleared" boundary that survives ring-buffer eviction. */
  debugFrameSeq: number;
  /** Per-port reachability of declared ports, watched by the runner and rendered
   *  on the endpoint badge (spinner → ok / error). Keyed by port. */
  portReachability: Map<number, RunReachabilityState>;
  /** Set when a run restored from the index could not be re-attached — the
   *  session is gone from the runner (evicted past its TTL / runner restarted)
   *  or its adapter can't resume. The list keeps the entry; the view shows a
   *  note instead of trying to stream. */
  historyUnavailable?: boolean;
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
  /** Drop a run from history: tears down its runtime, forgets its re-attach
   *  metadata, and removes it from the persisted index. Used to clear a run
   *  whose history is no longer available on the runner. */
  removeRun(runId: string): void;
  /** Clear an Application's finished run history. A still-live run
   *  (starting/running) is kept so it isn't orphaned. */
  clearRunsForApp(appPath: string): void;
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
  // Re-attach metadata, keyed by run id: which adapter ran the session and the
  // config (e.g. runner baseUrl) needed to reconnect to it after a reload. Held
  // in a ref so it is available to the persist effect synchronously, before any
  // state-driven effect can run and clobber the stored config.
  const attachMeta = useRef<Map<string, { adapterId: string; config: unknown }>>(new Map());

  // Seed the run list from the persisted index so a page reload restores history.
  const [runsByApp, setRunsByApp] = useState<Map<string, RunRecord[]>>(() => {
    const byApp = new Map<string, RunRecord[]>();
    for (const entry of loadRunIndex()) {
      attachMeta.current.set(entry.id, { adapterId: entry.adapterId, config: entry.config });
      const list = byApp.get(entry.appPath) ?? [];
      list.push(shellFromEntry(entry));
      byApp.set(entry.appPath, list);
    }
    for (const [appPath, list] of byApp) {
      list.sort((a, b) => b.startedAt - a.startedAt);
      byApp.set(appPath, list.slice(0, MAX_RUNS_PER_APP));
    }
    return byApp;
  });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [unavailableRun, setUnavailableRun] = useState<UnavailableRun | null>(null);
  const [isRunViewOpen, setIsRunViewOpen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  // Terminal buffers keyed by run id, held in STATE (not just the runtime ref)
  // so the view re-renders reactively when a buffer appears — load-bearing for
  // resume, where the buffer is attached asynchronously after the record already
  // exists, and a ref read on the next render isn't a reliable trigger.
  const [terminals, setTerminals] = useState<Map<string, TerminalBuffer>>(new Map());

  // Live run objects, keyed by run id. Reconciled against `runsByApp` so a run
  // that leaves React state (eviction) has its session/transcript torn down.
  const runtimes = useRef<Map<string, RunRuntime>>(new Map());
  // Runs whose re-attach is in flight, to dedupe concurrent attach attempts.
  const attaching = useRef<Set<string>>(new Set());

  /** Publish (or clear) a run's terminal buffer into reactive state so the view
   *  picks it up. Pass `null` to remove it. */
  const setTerminal = useCallback((runId: string, terminal: TerminalBuffer | null) => {
    setTerminals((prev) => {
      if (terminal === null && !prev.has(runId)) return prev;
      const next = new Map(prev);
      if (terminal === null) next.delete(runId);
      else next.set(runId, terminal);
      return next;
    });
  }, []);

  const disposeRuntime = useCallback(
    (runId: string) => {
      const rt = runtimes.current.get(runId);
      if (!rt) return;
      runtimes.current.delete(runId);
      rt.unsubscribe();
      // Evicting a still-running run must not leak the underlying container.
      if (!isTerminal(rt.session.getStatus())) {
        void rt.session.stop().catch(() => undefined);
      }
      rt.terminal?.dispose();
      setTerminal(runId, null);
    },
    [setTerminal],
  );

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

  // Tear down runtimes whose record left state (evicted past the per-app cap)
  // and forget their re-attach metadata.
  useEffect(() => {
    const live = new Set<string>();
    for (const records of runsByApp.values()) for (const r of records) live.add(r.id);
    for (const id of [...runtimes.current.keys()]) {
      if (!live.has(id)) disposeRuntime(id);
    }
    for (const id of [...attachMeta.current.keys()]) {
      if (!live.has(id)) attachMeta.current.delete(id);
    }
  }, [runsByApp, disposeRuntime]);

  // Mirror the run list to the persisted index so the next reload can restore it.
  // Bodies (logs/events) are never stored — only the pointer + last-known status.
  useEffect(() => {
    const entries: PersistedRunEntry[] = [];
    for (const [appPath, records] of runsByApp) {
      for (const record of records) {
        const meta = attachMeta.current.get(record.id);
        entries.push({
          id: record.id,
          appPath,
          adapterId: record.adapterId,
          adapterDisplayName: record.adapterDisplayName,
          hasTerminal: record.hasTerminal,
          startedAt: record.startedAt,
          status: record.status,
          config: meta?.config,
        });
      }
    }
    saveRunIndex(entries);
  }, [runsByApp]);

  // On provider teardown, stop every live session and detach subscriptions.
  useEffect(() => {
    const table = runtimes.current;
    return () => {
      for (const id of [...table.keys()]) disposeRuntime(id);
    };
  }, [disposeRuntime]);

  const closeRunView = useCallback(() => setIsRunViewOpen(false), []);
  const openRunView = useCallback(() => setIsRunViewOpen(true), []);

  // Re-establish a run restored from the index: reconnect to the still-live
  // session on the runner and replay its history. No-op once a runtime exists
  // (freshly started runs, or an already-attached one). Marks the record
  // unavailable when the session is gone or its adapter can't resume.
  const ensureAttached = useCallback(
    async (runId: string) => {
      if (runtimes.current.has(runId) || attaching.current.has(runId)) return;
      const meta = attachMeta.current.get(runId);
      if (!meta) return;
      const adapter = registry.get(meta.adapterId);
      if (!adapter?.attach) {
        updateRecord(runId, (record) => ({ ...record, historyUnavailable: true }));
        return;
      }
      attaching.current.add(runId);
      try {
        const session = await adapter.attach(runId, meta.config);
        if (!session) {
          updateRecord(runId, (record) => ({ ...record, historyUnavailable: true }));
          return;
        }
        const terminal = session.io ? new TerminalBuffer(session.io) : null;
        const runtime: RunRuntime = {
          session,
          terminal,
          unsubscribe: () => undefined,
          lineId: 0,
          partial: { stdout: "", stderr: "" },
        };
        runtimes.current.set(runId, runtime);
        if (terminal) setTerminal(runId, terminal);
        runtime.unsubscribe = session.subscribe((event) => {
          applyRunEvent(event, runId, runtime, terminal !== null, updateRecord);
        });
        updateRecord(runId, (record) => ({
          ...record,
          status: session.getStatus(),
          hasTerminal: terminal !== null,
          historyUnavailable: false,
        }));
      } catch (err) {
        console.warn("run attach failed:", err);
        updateRecord(runId, (record) => ({ ...record, historyUnavailable: true }));
      } finally {
        attaching.current.delete(runId);
      }
    },
    [updateRecord, setTerminal],
  );

  const selectRun = useCallback(
    (runId: string) => {
      setUnavailableRun(null);
      setSelectedRunId(runId);
      setIsRunViewOpen(true);
      void ensureAttached(runId);
    },
    [ensureAttached],
  );

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

  const removeRun = useCallback((runId: string) => {
    // Clearing the selection first means RunView falls back to its empty state
    // for a removed run that was on screen. The runsByApp change drives the rest:
    // the eviction effect disposes any runtime + forgets its re-attach metadata,
    // and the persist effect rewrites the index without it.
    setSelectedRunId((cur) => (cur === runId ? null : cur));
    setRunsByApp((prev) => {
      let found = false;
      const next = new Map(prev);
      for (const [appPath, records] of prev) {
        if (!records.some((r) => r.id === runId)) continue;
        found = true;
        next.set(
          appPath,
          records.filter((r) => r.id !== runId),
        );
      }
      return found ? next : prev;
    });
  }, []);

  const clearRunsForApp = useCallback(
    (appPath: string) => {
      const records = runsByApp.get(appPath) ?? [];
      // Only the finished runs are "history"; keep any live run so the eviction
      // effect doesn't tear down (and orphan) a still-running workload.
      const clearedIds = new Set(records.filter((r) => isTerminal(r.status)).map((r) => r.id));
      if (clearedIds.size === 0) return;
      setSelectedRunId((cur) => (cur && clearedIds.has(cur) ? null : cur));
      setRunsByApp((prev) => {
        const cur = prev.get(appPath);
        if (!cur) return prev;
        const kept = cur.filter((r) => !clearedIds.has(r.id));
        const next = new Map(prev);
        if (kept.length > 0) next.set(appPath, kept);
        else next.delete(appPath);
        return next;
      });
    },
    [runsByApp],
  );

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
        debugFrames: [],
        debugFrameSeq: 0,
        portReachability: new Map(),
      };

      const runtime: RunRuntime = {
        session,
        terminal,
        unsubscribe: () => undefined,
        lineId: 0,
        partial: { stdout: "", stderr: "" },
      };
      runtimes.current.set(record.id, runtime);
      if (terminal) setTerminal(record.id, terminal);
      attachMeta.current.set(record.id, { adapterId: adapter.id, config });
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
    [updateRecord, setTerminal],
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
    (runId: string) => terminals.get(runId) ?? null,
    [terminals],
  );

  const value = useMemo<RunContextValue>(
    () => ({
      selectedRun,
      unavailableRun,
      isRunViewOpen,
      isStarting,
      startRun,
      stopRun,
      removeRun,
      clearRunsForApp,
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
      removeRun,
      clearRunsForApp,
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

/** Build an empty display record from a persisted index entry. Bodies (lines,
 *  debug frames, terminal scrollback) stay empty until the run is selected and
 *  re-attached, which replays them from the runner. */
function shellFromEntry(entry: PersistedRunEntry): RunRecord {
  return {
    id: entry.id,
    appPath: entry.appPath,
    adapterId: entry.adapterId,
    adapterDisplayName: entry.adapterDisplayName,
    status: entry.status,
    startedAt: entry.startedAt,
    hasTerminal: entry.hasTerminal,
    progress: null,
    lines: [],
    truncated: false,
    debugFrames: [],
    debugFrameSeq: 0,
    portReachability: new Map(),
  };
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

  if (event.type === "debug") {
    // The editor shows logs through the run's terminal / LogStream slot, so only
    // relayed *event* frames feed the Events tab; relayed log frames are dropped.
    if (isLogFrame(event.frame)) return;
    updateRecord(runId, (record) => appendDebugFrames(record, [event.frame]));
    return;
  }

  if (event.type === "reachability") {
    updateRecord(runId, (record) => ({
      ...record,
      portReachability: new Map(record.portReachability).set(event.port, event.state),
    }));
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

/** Append debug frames to a record, ring-capped at {@link MAX_DEBUG_FRAMES}.
 *  `debugFrameSeq` counts every frame ever appended (even evicted ones) so the
 *  view's cleared/paused boundary stays correct after eviction. */
function appendDebugFrames(record: RunRecord, frames: DebugFrame[]): RunRecord {
  const combined = [...record.debugFrames, ...frames];
  const overflow = combined.length - MAX_DEBUG_FRAMES;
  return {
    ...record,
    debugFrames: overflow > 0 ? combined.slice(overflow) : combined,
    debugFrameSeq: record.debugFrameSeq + frames.length,
  };
}

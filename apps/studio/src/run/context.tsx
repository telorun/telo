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

import { toast } from "sonner";

import { type DebugFrame, isEventFrame } from "@telorun/debug-wire";

import type { SessionAgentState, WorkspaceBridge } from "../agent/types";
import type { ResumeSecretStore } from "./runner-credentials";
import type { DesiredAppSet } from "./session-apps";
import { TerminalBuffer } from "./terminal-buffer";
import type {
  AvailabilityAction,
  RunAdapter,
  RunAppRequest,
  RunEvent,
  RunnerEndpoint,
  RunnerTerms,
  RunOutcomeEvent,
  RunPhase,
  RunReachabilityState,
  RunRouteState,
  SequencedRunIo,
} from "./types";
import type { WorkspaceSessionEntry } from "./workspace-session-entry";
import {
  RunWithdrawnError,
  WorkspaceSession,
  type WorkspaceIdentity,
  type WorkspaceSessionState,
} from "./workspace-session";

/** Per-application run history cap. Oldest runs beyond this are evicted and
 *  their terminal torn down. */
const MAX_RUNS_PER_APP = 10;
/** Ring cap on buffered debug frames (events + log lines) held per run. */
const MAX_DEBUG_FRAMES = 5_000;
/** How long a run's terminal keeps listening after the run ended: its last
 *  output and its ending travel on two channels. */
const RUN_OUTPUT_GRACE_MS = 1_000;
/** How long a run this page did not start waits before its terminal opens. */
const ADOPTED_TERMINAL_DELAY_MS = 300;

/** How one run of one app stands. `queued` is a Run waiting on the session —
 *  the session itself, the app set, or the app's container — and says which
 *  through the session's state. */
export type AppRunStatus =
  | { kind: "queued" }
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "exited"; code: number }
  | { kind: "signalled"; signal: string }
  | { kind: "failed"; message: string }
  | { kind: "stopped" };

export function isRunLive(status: AppRunStatus): boolean {
  return status.kind === "queued" || status.kind === "starting" || status.kind === "running";
}

/** One run of one Application — a Run pressed, or a run the session reports
 *  that this page did not start (re-attached after a reload). Newest-first
 *  within its app's list. Live objects (the terminal) live in a ref-held side
 *  table keyed by `id`, so high-frequency byte output never churns React state. */
export interface RunRecord {
  id: string;
  /** The runner's id for the run, once it started. */
  runId?: string;
  /** Application module `filePath` this run belongs to. */
  appPath: string;
  /** The app's name in the session. */
  app: string;
  /** The runner that runs it, as named in settings. */
  runnerName: string;
  status: AppRunStatus;
  startedAt: number;
  /** True once the run streams a terminal — read via `getTerminal(id)`. */
  hasTerminal: boolean;
  /** Latest coming-up progress of the app while its run starts. */
  progress: { phase: RunPhase; message: string } | null;
  /** Frames from the workload's kernel debug stream (events), fed to the Debug
   *  panel's Events tab. Newest appended; capped. */
  debugFrames: DebugFrame[];
  /** Total frames ever appended (incl. evicted ones). */
  debugFrameSeq: number;
  /** Per-port reachability of the app's declared ports, while it runs. */
  portReachability: Map<number, RunReachabilityState>;
  /** Whether the runner's cluster programmed each published host, keyed by port. */
  portRoutes: Map<number, { state: RunRouteState; host: string; app?: string; reason?: string }>;
  /** Latest generation outcome of the app, keyed by app name. */
  runs: Record<string, RunOutcomeEvent>;
  /** The telo version the app's set entry named; absent when the runner does
   *  not choose one per application. */
  requestedTelo?: string;
  /** The version the app's runtime last reported for itself, by app name. */
  reportedTelo: Record<string, string>;
  /** Declared ports the runner could not route, by port, with its reason. */
  unroutablePorts: Map<number, string>;
  /** The endpoints the session publishes for this app's ports. */
  endpoints: RunnerEndpoint[];
  /** Set once Stop was pressed: the run's ending is then read as stopped. */
  stopRequested?: boolean;
}

/** The co-resident agent of the workspace's session, while it is running. */
export interface CoResidentAgentSession {
  sessionId: string;
  baseUrl: string;
  token?: string;
}

/** Unavailable/setup-required banner shown in the run dock when a run failed to
 *  start because of environment or config. Not a run — no record, no events. */
export interface UnavailableRun {
  adapterId: string;
  adapterDisplayName: string;
  message: string;
  remediation?: string;
  action?: AvailabilityAction;
  recheck?: () => Promise<void>;
}

/** One required variable/secret an Application declares with no default and no
 *  value in the workspace's env files — a run cannot start until it is filled. */
export interface MissingConfigEntry {
  name: string;
  envVar: string;
  secret: boolean;
}

/** An env file — or the workspace marker bounding them — that keeps the
 *  workspace's env files from being the run's environment. */
export interface EnvFileProblem {
  /** Relative to the workspace root. */
  file: string;
  reason: string;
}

/** Why a run never started. Held per Application and rendered in that app's run
 *  dock — the same surface the run's own output would have used. */
export type RunBlocker =
  | ({ kind: "unavailable" } & UnavailableRun)
  | { kind: "missing-config"; entries: MissingConfigEntry[] }
  | { kind: "env-files"; problems: EnvFileProblem[] }
  | { kind: "outside-workspace"; importer: string; source: string; target: string };

/** Per-Application dock geometry, held in memory. */
export interface RunDockState {
  open: boolean;
  height: number;
  maximized: boolean;
}

export const RUN_DOCK_MIN_HEIGHT = 160;
const DEFAULT_DOCK: RunDockState = { open: false, height: 340, maximized: false };

/**
 * What the editor binds the run context to: one open workspace in Agent or
 * Manual mode, on one runner. A new binding (another workspace, another runner,
 * Only on this device) lets go of the previous session, suspending it.
 */
export interface WorkspaceBinding {
  workspaceKey: string;
  entry: WorkspaceSessionEntry;
  mode: "agent" | "manual";
  runner: { id: string; name: string; adapter: RunAdapter<unknown>; config: unknown };
  termsAccepted(terms: RunnerTerms): boolean;
  secrets: ResumeSecretStore;
  /** The signed-in identity; null when signed out. A change rebinds. */
  identity: WorkspaceIdentity | null;
  saveEntry(entry: WorkspaceSessionEntry): void;
  bridge: WorkspaceBridge;
  /** A fresh Run request for an app the session asks to start again, or null
   *  when it cannot run now (the reason shown as its dock's blocker). */
  prepareRun(appPath: string): Promise<RunAppRequest | null>;
}

interface RunContextValue {
  /** Bind (or unbind, with null) the open workspace's session. */
  bindWorkspace(binding: WorkspaceBinding | null): void;
  /** The workspace session, or null where there is none. */
  session: WorkspaceSessionState | null;
  /** The runner's terms were accepted: carry on opening the session. */
  acceptSessionTerms(version: string): void;
  /** Try to open the session again after it could not be had. */
  retrySession(): void;
  /** The workspace's app set, as the editor computes it. */
  setDesiredApps(set: DesiredAppSet): void;
  /** Whether an agent turn runs: an app-set change waits for it. */
  setTurnActive(active: boolean): void;
  /** Push the editor's files into the session after a save. */
  syncWorkspace(): void;
  /** Whether a sync into the session is in flight. */
  syncing(): boolean;
  /** The session's agent, as the agent panel consumes it. */
  sessionAgent: SessionAgentState;
  /** The app's name in the session, or null when it is not in the set. */
  appNameOf(appPath: string): string | null;
  /** The io a Run asks for on this runner. */
  runIo(): RunAppRequest["io"];

  /** Run an Application with the request the editor prepared. */
  runApp(appPath: string, request: RunAppRequest): Promise<void>;
  stopRun(recordId: string): Promise<void>;
  reloadRun(recordId: string): Promise<void>;
  removeRun(recordId: string): void;
  clearRunsForApp(appPath: string): void;
  selectRun(recordId: string): void;
  runsForApp(appPath: string): RunRecord[];
  liveRunForApp(appPath: string): RunRecord | null;
  latestRunForApp(appPath: string): RunRecord | null;
  selectedRunForApp(appPath: string): RunRecord | null;
  isStartingApp(appPath: string): boolean;

  blockerForApp(appPath: string): RunBlocker | null;
  showBlocker(appPath: string, blocker: RunBlocker): void;
  clearBlocker(appPath: string): void;

  dockForApp(appPath: string): RunDockState;
  dockHasContent(appPath: string): boolean;
  /** Whether the dock COVERS the module pane right now: maximized, open, and
   *  holding something — the one authority the dock, the view area and the
   *  bar's restore toggle all render against. */
  dockFillsPane(appPath: string): boolean;
  setDockOpen(appPath: string, open: boolean): void;
  setDockHeight(appPath: string, height: number): void;
  setDockMaximized(appPath: string, maximized: boolean): void;

  /** Forget everything held for an Application — its runs, its dock, its
   *  blocker and its selection — stopping a live run of it. */
  forgetApp(appPath: string): void;

  getTerminal(recordId: string): TerminalBuffer | null;
}

const RunContextValue = createContext<RunContextValue | null>(null);

export function useRun(): RunContextValue {
  const ctx = useContext(RunContextValue);
  if (!ctx) throw new Error("useRun() called outside <RunProvider>");
  return ctx;
}

function newRecord(fields: { appPath: string; app: string; runnerName: string; status: AppRunStatus; requestedTelo?: string }): RunRecord {
  return {
    id: crypto.randomUUID(),
    appPath: fields.appPath,
    app: fields.app,
    runnerName: fields.runnerName,
    status: fields.status,
    startedAt: Date.now(),
    hasTerminal: false,
    progress: null,
    debugFrames: [],
    debugFrameSeq: 0,
    portReachability: new Map(),
    portRoutes: new Map(),
    runs: {},
    ...(fields.requestedTelo !== undefined ? { requestedTelo: fields.requestedTelo } : {}),
    reportedTelo: {},
    unroutablePorts: new Map(),
    endpoints: [],
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function RunProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<WorkspaceSessionState | null>(null);
  const controllerRef = useRef<WorkspaceSession | null>(null);
  const bindingRef = useRef<WorkspaceBinding | null>(null);
  // App name ↔ module path, from the editor's app set — in state for readers,
  // and in a ref for the event handlers, which outlive a render.
  const [apps, setApps] = useState<AppIndex>(EMPTY_APPS);
  const appsRef = useRef(apps);
  appsRef.current = apps;

  const [runsByApp, setRunsByApp] = useState<Map<string, RunRecord[]>>(new Map());
  const runsRef = useRef(runsByApp);
  runsRef.current = runsByApp;
  const [selectedRunIdByApp, setSelectedRunIdByApp] = useState<Map<string, string>>(new Map());
  const [blockerByApp, setBlockerByApp] = useState<Map<string, RunBlocker>>(new Map());
  const [dockByApp, setDockByApp] = useState<Map<string, RunDockState>>(new Map());
  const [terminals, setTerminals] = useState<Map<string, TerminalBuffer>>(new Map());
  // Each run's byte channel, so the next run of the app starts after it.
  const ios = useRef<Map<string, SequencedRunIo>>(new Map());
  const terminalTable = useRef<Map<string, TerminalBuffer>>(new Map());

  const setTerminal = useCallback((recordId: string, terminal: TerminalBuffer | null) => {
    setTerminals((prev) => {
      if (terminal === null && !prev.has(recordId)) return prev;
      const next = new Map(prev);
      if (terminal === null) next.delete(recordId);
      else next.set(recordId, terminal);
      return next;
    });
  }, []);

  const disposeTerminal = useCallback(
    (recordId: string) => {
      terminalTable.current.get(recordId)?.dispose();
      terminalTable.current.delete(recordId);
      ios.current.delete(recordId);
      setTerminal(recordId, null);
    },
    [setTerminal],
  );

  // Each change is applied to the ref at once as well, so the event handlers
  // that follow it in the same tick see it; the render that commits it
  // assigns the same value.
  const updateRecord = useCallback((recordId: string, mut: (record: RunRecord) => RunRecord) => {
    const apply = (prev: Map<string, RunRecord[]>) => {
      for (const [appPath, records] of prev) {
        const idx = records.findIndex((r) => r.id === recordId);
        if (idx === -1) continue;
        const nextRecords = records.slice();
        nextRecords[idx] = mut(records[idx]!);
        const next = new Map(prev);
        next.set(appPath, nextRecords);
        return next;
      }
      return prev;
    };
    runsRef.current = apply(runsRef.current);
    setRunsByApp(apply);
  }, []);

  const addRecord = useCallback((record: RunRecord) => {
    const apply = (prev: Map<string, RunRecord[]>) => {
      const next = new Map(prev);
      next.set(record.appPath, [record, ...(prev.get(record.appPath) ?? [])].slice(0, MAX_RUNS_PER_APP));
      return next;
    };
    runsRef.current = apply(runsRef.current);
    setRunsByApp(apply);
  }, []);

  // Tear down terminals whose record left state (evicted past the per-app cap).
  useEffect(() => {
    const live = new Set<string>();
    for (const records of runsByApp.values()) for (const r of records) live.add(r.id);
    for (const id of [...terminalTable.current.keys()]) if (!live.has(id)) disposeTerminal(id);
  }, [runsByApp, disposeTerminal]);

  /** Give a run its terminal: the app's byte channel from after the previous
   *  run's output. */
  const attachTerminal = useCallback(
    (record: RunRecord) => {
      const controller = controllerRef.current;
      if (!controller || terminalTable.current.has(record.id)) return;
      const previous = (runsRef.current.get(record.appPath) ?? []).find(
        (r) => r.id !== record.id && ios.current.has(r.id),
      );
      const io = controller.io(record.app, previous ? ios.current.get(previous.id)!.lastSeq() : 0);
      const terminal = new TerminalBuffer(io);
      ios.current.set(record.id, io);
      terminalTable.current.set(record.id, terminal);
      setTerminal(record.id, terminal);
      // The session publishes every app's ports; this run's are its app's own.
      const ports = appsRef.current.ports.get(record.app) ?? new Set<string>();
      const endpoints = controller.state.endpoints.filter((e) => ports.has(`${e.protocol}/${e.port}`));
      updateRecord(record.id, (r) => ({ ...r, hasTerminal: true, endpoints }));
    },
    [setTerminal, updateRecord],
  );

  /** Give a run its runner id, and its terminal. */
  const attachRun = useCallback(
    (record: RunRecord, runId: string) => {
      updateRecord(record.id, (r) => ({ ...r, runId }));
      attachTerminal(record);
    },
    [attachTerminal, updateRecord],
  );

  /** The run an app's events belong to: its live one, else its latest started. */
  const currentRecord = useCallback((appPath: string, runId?: string): RunRecord | null => {
    const records = runsRef.current.get(appPath) ?? [];
    if (runId) {
      const exact = records.find((r) => r.runId === runId);
      if (exact) return exact;
    }
    return records.find((r) => r.status.kind === "running" || r.status.kind === "starting") ?? records.find((r) => r.runId) ?? null;
  }, []);

  const runnerName = () => bindingRef.current?.runner.name ?? "";

  const applyEvent = useCallback(
    (event: RunEvent) => {
      if (event.type === "status" || (event.type === "progress" && event.app === undefined)) return;
      const appPath = appsRef.current.byName.get(event.app ?? "");
      if (!appPath) return;

      if (event.type === "app") {
        if (event.state === "running") {
          const records = runsRef.current.get(appPath) ?? [];
          const known = records.find((r) => r.runId === event.runId);
          const waiting = known ?? records.find((r) => !r.runId && (r.status.kind === "starting" || r.status.kind === "queued"));
          if (waiting) {
            if (!waiting.runId) attachRun(waiting, event.runId);
            updateRecord(waiting.id, (r) => ({ ...r, status: { kind: "running" }, progress: null }));
            return;
          }
          // A run this page did not start: one live before a reload, or a
          // rerun another client asked for.
          const adopted = newRecord({
            appPath,
            app: event.app,
            runnerName: runnerName(),
            status: { kind: "running" },
            requestedTelo: appsRef.current.telo.get(event.app),
          });
          addRecord({ ...adopted, runId: event.runId });
          // A replayed run that ended long ago arrives with its ending right
          // behind it; only one still running gets a terminal.
          setTimeout(() => {
            const current = (runsRef.current.get(appPath) ?? []).find((r) => r.id === adopted.id);
            if (current && current.status.kind === "running") attachTerminal(current);
          }, ADOPTED_TERMINAL_DELAY_MS);
          return;
        }
        const ended = event.ended;
        if (!ended) return;
        const record = (runsRef.current.get(appPath) ?? []).find((r) => r.runId === ended.runId);
        if (!record) return;
        // The app's byte channel goes on to its next run: this run's terminal
        // stops listening once its trailing output has arrived, keeping what
        // it recorded.
        setTimeout(() => terminalTable.current.get(record.id)?.dispose(), RUN_OUTPUT_GRACE_MS);
        updateRecord(record.id, (r) => ({
          ...r,
          progress: null,
          status: r.stopRequested
            ? { kind: "stopped" }
            : ended.code !== undefined
              ? { kind: "exited", code: ended.code }
              : ended.signal !== undefined
                ? { kind: "signalled", signal: ended.signal }
                : { kind: "failed", message: ended.reason ?? "The run ended." },
        }));
        return;
      }

      const record = currentRecord(appPath);
      if (!record) return;
      switch (event.type) {
        case "progress":
          updateRecord(record.id, (r) =>
            r.status.kind === "starting" || r.status.kind === "queued" ? { ...r, progress: { phase: event.phase, message: event.message } } : r,
          );
          return;
        case "debug":
          if (!isEventFrame(event.frame)) return;
          updateRecord(record.id, (r) => appendDebugFrames(r, [event.frame]));
          return;
        case "reachability":
          updateRecord(record.id, (r) => ({
            ...r,
            portReachability: new Map(r.portReachability).set(event.port, event.state),
          }));
          return;
        case "route":
          // Kept apart from reachability on purpose: an unprogrammed route is
          // the one failure where the port answers the runner and the URL the
          // user was handed does not.
          updateRecord(record.id, (r) => ({
            ...r,
            portRoutes: new Map(r.portRoutes).set(event.port, {
              state: event.state,
              host: event.host,
              ...(event.app ? { app: event.app } : {}),
              ...(event.reason ? { reason: event.reason } : {}),
            }),
          }));
          return;
        case "run":
          updateRecord(record.id, (r) => ({
            ...r,
            runs: { ...r.runs, [event.app]: event },
            ...(event.phase === "started"
              ? { reportedTelo: reportedAfter(r.reportedTelo, event.app, event.telo) }
              : {}),
          }));
          return;
        case "endpoints":
          updateRecord(record.id, (r) => {
            const removed = new Set((event.removed ?? []).map((e) => `${e.protocol}/${e.port}`));
            const endpoints = [...r.endpoints.filter((e) => !removed.has(`${e.protocol}/${e.port}`)), ...(event.added ?? [])];
            const unroutable = new Map(r.unroutablePorts);
            for (const entry of event.rejected ?? []) unroutable.set(entry.port, entry.reason);
            for (const entry of event.added ?? []) unroutable.delete(entry.port);
            const routes = new Map(r.portRoutes);
            for (const entry of event.removed ?? []) routes.delete(entry.port);
            return { ...r, endpoints, unroutablePorts: unroutable, portRoutes: routes };
          });
          return;
      }
    },
    [addRecord, attachRun, attachTerminal, currentRecord, updateRecord],
  );
  const applyEventRef = useRef(applyEvent);
  applyEventRef.current = applyEvent;

  const updateDock = useCallback((appPath: string, mut: (prev: RunDockState) => RunDockState) => {
    setDockByApp((prev) => {
      const cur = prev.get(appPath) ?? DEFAULT_DOCK;
      const next = mut(cur);
      if (next.open === cur.open && next.height === cur.height && next.maximized === cur.maximized) return prev;
      const map = new Map(prev);
      map.set(appPath, next);
      return map;
    });
  }, []);
  const dockForApp = useCallback((appPath: string) => dockByApp.get(appPath) ?? DEFAULT_DOCK, [dockByApp]);
  const setDockOpen = useCallback(
    (appPath: string, open: boolean) => updateDock(appPath, (d) => ({ ...d, open })),
    [updateDock],
  );
  const setDockHeight = useCallback(
    (appPath: string, height: number) =>
      updateDock(appPath, (d) => ({ ...d, height: Math.max(RUN_DOCK_MIN_HEIGHT, height) })),
    [updateDock],
  );
  const setDockMaximized = useCallback(
    (appPath: string, maximized: boolean) => updateDock(appPath, (d) => ({ ...d, maximized })),
    [updateDock],
  );
  const restDock = useCallback(
    (appPath: string) => updateDock(appPath, (d) => ({ ...d, open: false, maximized: false })),
    [updateDock],
  );

  const setBlocker = useCallback((appPath: string, blocker: RunBlocker | null) => {
    setBlockerByApp((prev) => {
      if (blocker === null && !prev.has(appPath)) return prev;
      const next = new Map(prev);
      if (blocker === null) next.delete(appPath);
      else next.set(appPath, blocker);
      return next;
    });
  }, []);
  const blockerForApp = useCallback((appPath: string) => blockerByApp.get(appPath) ?? null, [blockerByApp]);
  const clearBlocker = useCallback((appPath: string) => setBlocker(appPath, null), [setBlocker]);
  const showBlocker = useCallback(
    (appPath: string, blocker: RunBlocker) => {
      setBlocker(appPath, blocker);
      setDockOpen(appPath, true);
    },
    [setBlocker, setDockOpen],
  );

  const setSelectedRunForApp = useCallback((appPath: string, recordId: string) => {
    setSelectedRunIdByApp((prev) => {
      if (prev.get(appPath) === recordId) return prev;
      const next = new Map(prev);
      next.set(appPath, recordId);
      return next;
    });
  }, []);
  const forgetSelection = useCallback((match: (recordId: string) => boolean) => {
    setSelectedRunIdByApp((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [appPath, recordId] of prev) {
        if (!match(recordId)) continue;
        next.delete(appPath);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  // The last app set the editor computed, for a session bound after it.
  const desiredRef = useRef<DesiredAppSet | null>(null);
  const runAppRef = useRef<(appPath: string, request: RunAppRequest) => Promise<void>>(async () => undefined);

  const bindWorkspace = useCallback((binding: WorkspaceBinding | null) => {
    const previous = bindingRef.current;
    const sameSession =
      previous !== null &&
      binding !== null &&
      previous.workspaceKey === binding.workspaceKey &&
      previous.runner.id === binding.runner.id &&
      previous.runner.config === binding.runner.config &&
      previous.identity === binding.identity;
    bindingRef.current = binding;
    if (sameSession) {
      controllerRef.current?.setMode(binding.mode);
      return;
    }
    const old = controllerRef.current;
    controllerRef.current = null;
    if (old) {
      void old.suspend().catch((err: unknown) =>
        toast.error("Couldn't suspend the workspace's session", { description: message(err), duration: 10_000 }),
      );
    }
    for (const id of [...terminalTable.current.keys()]) disposeTerminal(id);
    setRunsByApp(new Map());
    setSelectedRunIdByApp(new Map());
    setBlockerByApp(new Map());
    if (!binding) {
      setSession(null);
      return;
    }
    const controller = new WorkspaceSession({
      workspaceKey: binding.workspaceKey,
      entry: binding.entry,
      runner: binding.runner,
      mode: binding.mode,
      termsAccepted: binding.termsAccepted,
      secrets: binding.secrets,
      identity: binding.identity,
      saveEntry: binding.saveEntry,
      bridge: binding.bridge,
      listener: {
        changed: () => {
          if (controllerRef.current === controller) setSession(controller.state);
        },
        event: (event) => {
          if (controllerRef.current === controller) applyEventRef.current(event);
        },
        rerun: (app) => {
          const appPath = appsRef.current.byName.get(app);
          const current = bindingRef.current;
          if (!appPath || !current || controllerRef.current !== controller) return;
          void current
            .prepareRun(appPath)
            .then((request) => (request ? runAppRef.current(appPath, request) : undefined))
            .catch((err: unknown) =>
              toast.error(`Couldn't start '${app}' again`, { description: message(err), duration: 10_000 }),
            );
        },
        syncFailed: (text) => toast.error(text, { duration: 10_000 }),
      },
    });
    controllerRef.current = controller;
    const desired = desiredRef.current;
    if (desired) controller.setDesired(desired.apps.map((a) => a.spec), desired.settled, desired.versioned);
    setSession(controller.state);
    void controller.open();
  }, [disposeTerminal]);

  // Let go of the session when the provider goes away (the page stays: the
  // runner suspends it once nothing subscribes).
  useEffect(
    () => () => {
      controllerRef.current?.dispose();
      for (const terminal of terminalTable.current.values()) terminal.dispose();
    },
    [],
  );

  const acceptSessionTerms = useCallback((version: string) => controllerRef.current?.acceptTerms(version), []);
  const retrySession = useCallback(() => void controllerRef.current?.open(), []);
  const setDesiredApps = useCallback((set: DesiredAppSet) => {
    desiredRef.current = set;
    const next: AppIndex = { byPath: new Map(), byName: new Map(), telo: new Map(), ports: new Map() };
    for (const app of set.apps) {
      next.byPath.set(app.appPath, app.spec.name);
      next.byName.set(app.spec.name, app.appPath);
      next.ports.set(app.spec.name, new Set((app.spec.ports ?? []).map((p) => `${p.protocol}/${p.port}`)));
      if (app.spec.telo !== undefined) next.telo.set(app.spec.name, app.spec.telo);
    }
    appsRef.current = next;
    setApps(next);
    controllerRef.current?.setDesired(
      set.apps.map((a) => a.spec),
      set.settled,
      set.versioned,
    );
  }, []);
  const setTurnActive = useCallback((active: boolean) => controllerRef.current?.setTurnActive(active), []);
  const syncWorkspace = useCallback(() => controllerRef.current?.sync(), []);
  const syncing = useCallback(() => controllerRef.current?.syncing ?? false, []);
  const appNameOf = useCallback((appPath: string) => apps.byPath.get(appPath) ?? null, [apps]);
  const runIo = useCallback(() => controllerRef.current?.runIo ?? "tty", []);

  const runApp = useCallback(
    async (appPath: string, request: RunAppRequest) => {
      const controller = controllerRef.current;
      const app = appsRef.current.byPath.get(appPath);
      if (!controller || !app) throw new Error("This application is not part of the workspace's session.");
      setBlocker(appPath, null);
      setDockOpen(appPath, true);
      const record = newRecord({
        appPath,
        app,
        runnerName: runnerName(),
        status: { kind: "queued" },
        requestedTelo: appsRef.current.telo.get(app),
      });
      addRecord(record);
      setSelectedRunForApp(appPath, record.id);
      try {
        const runId = await controller.run(app, request);
        const current = (runsRef.current.get(appPath) ?? []).find((r) => r.id === record.id);
        if (!current) return;
        if (!current.runId) attachRun(current, runId);
        updateRecord(record.id, (r) => (r.status.kind === "queued" ? { ...r, status: { kind: "starting" } } : r));
      } catch (err) {
        updateRecord(record.id, (r) => ({
          ...r,
          progress: null,
          status: err instanceof RunWithdrawnError ? { kind: "stopped" } : { kind: "failed", message: message(err) },
        }));
      }
    },
    [addRecord, attachRun, setBlocker, setDockOpen, setSelectedRunForApp, updateRecord],
  );
  runAppRef.current = runApp;

  const findRecord = (recordId: string): RunRecord | null => {
    for (const records of runsRef.current.values()) {
      const found = records.find((r) => r.id === recordId);
      if (found) return found;
    }
    return null;
  };

  /** Stop a run: a waiting one is withdrawn, a live one is ended by the runner
   *  and reads as stopped when its ending arrives. A Stop that fails says so. */
  const stopRun = useCallback(
    async (recordId: string) => {
      const record = findRecord(recordId);
      const controller = controllerRef.current;
      if (!record || !controller || !isRunLive(record.status)) return;
      if (record.status.kind === "queued" && controller.withdraw(record.app)) return;
      updateRecord(recordId, (r) => ({ ...r, stopRequested: true }));
      try {
        await controller.stop(record.app);
      } catch (err) {
        updateRecord(recordId, (r) => ({ ...r, stopRequested: false }));
        toast.error("Couldn't stop the run", { description: message(err), duration: 10_000 });
      }
    },
    [updateRecord],
  );

  const reloadRun = useCallback(async (recordId: string) => {
    const record = findRecord(recordId);
    const controller = controllerRef.current;
    if (!record || !controller) return;
    await controller.reload(record.app);
  }, []);

  const removeRun = useCallback(
    (recordId: string) => {
      forgetSelection((id) => id === recordId);
      setRunsByApp((prev) => {
        let found = false;
        const next = new Map(prev);
        for (const [appPath, records] of prev) {
          if (!records.some((r) => r.id === recordId)) continue;
          found = true;
          next.set(
            appPath,
            records.filter((r) => r.id !== recordId),
          );
        }
        return found ? next : prev;
      });
    },
    [forgetSelection],
  );

  const clearRunsForApp = useCallback(
    (appPath: string) => {
      const records = runsByApp.get(appPath) ?? [];
      const clearedIds = new Set(records.filter((r) => !isRunLive(r.status)).map((r) => r.id));
      if (clearedIds.size === 0) return;
      forgetSelection((id) => clearedIds.has(id));
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
    [runsByApp, forgetSelection],
  );

  const selectRun = useCallback(
    (recordId: string) => {
      const record = findRecord(recordId);
      if (!record) return;
      setBlocker(record.appPath, null);
      setSelectedRunForApp(record.appPath, recordId);
      setDockOpen(record.appPath, true);
    },
    [setBlocker, setSelectedRunForApp, setDockOpen],
  );

  const runsForApp = useCallback((appPath: string) => runsByApp.get(appPath) ?? [], [runsByApp]);
  const liveRunForApp = useCallback(
    (appPath: string) => (runsByApp.get(appPath) ?? []).find((r) => isRunLive(r.status)) ?? null,
    [runsByApp],
  );
  const latestRunForApp = useCallback((appPath: string) => (runsByApp.get(appPath) ?? [])[0] ?? null, [runsByApp]);
  const selectedRunForApp = useCallback(
    (appPath: string): RunRecord | null => {
      const records = runsByApp.get(appPath) ?? [];
      const selectedId = selectedRunIdByApp.get(appPath);
      const selected = selectedId ? records.find((r) => r.id === selectedId) : undefined;
      if (selected) return selected;
      return records.find((r) => isRunLive(r.status)) ?? records[0] ?? null;
    },
    [runsByApp, selectedRunIdByApp],
  );
  const isStartingApp = useCallback(
    (appPath: string) => (runsByApp.get(appPath) ?? []).some((r) => r.status.kind === "starting"),
    [runsByApp],
  );
  const getTerminal = useCallback((recordId: string) => terminals.get(recordId) ?? null, [terminals]);

  const dockHasContent = useCallback(
    (appPath: string) => blockerByApp.has(appPath) || selectedRunForApp(appPath) !== null,
    [blockerByApp, selectedRunForApp],
  );
  const dockFillsPane = useCallback(
    (appPath: string) => {
      const dock = dockForApp(appPath);
      return dock.maximized && dock.open && dockHasContent(appPath);
    },
    [dockForApp, dockHasContent],
  );

  // Geometry follows content, reconciled in ONE place: a maximized dock with
  // nothing in it would hide the view area with nothing left to bring it back.
  useEffect(() => {
    for (const [appPath, dock] of dockByApp) {
      if (!dock.open && !dock.maximized) continue;
      const hasContent = blockerByApp.has(appPath) || (runsByApp.get(appPath) ?? []).length > 0;
      if (!hasContent) restDock(appPath);
    }
  }, [dockByApp, runsByApp, blockerByApp, restDock]);

  const forgetApp = useCallback(
    (appPath: string) => {
      // The application is gone, so nothing of it may keep running.
      const live = (runsRef.current.get(appPath) ?? []).find((r) => isRunLive(r.status));
      const controller = controllerRef.current;
      if (live && controller) {
        if (!controller.withdraw(live.app)) {
          void controller.stop(live.app).catch((err: unknown) =>
            toast.error("Couldn't stop a run of the deleted application", {
              description: `${appPath}: ${message(err)}`,
              duration: 10_000,
            }),
          );
        }
      }
      for (const record of runsRef.current.get(appPath) ?? []) disposeTerminal(record.id);
      setRunsByApp((prev) => {
        if (!prev.has(appPath)) return prev;
        const next = new Map(prev);
        next.delete(appPath);
        return next;
      });
      setBlocker(appPath, null);
      setDockByApp((prev) => {
        if (!prev.has(appPath)) return prev;
        const next = new Map(prev);
        next.delete(appPath);
        return next;
      });
      setSelectedRunIdByApp((prev) => {
        if (!prev.has(appPath)) return prev;
        const next = new Map(prev);
        next.delete(appPath);
        return next;
      });
    },
    [disposeTerminal, setBlocker],
  );

  const sessionAgent = useMemo((): SessionAgentState => {
    const controller = controllerRef.current;
    if (!session || !controller) return { kind: "none", reason: NO_SESSION_REASON };
    if (session.phase === "failed") return { kind: "none", reason: `The workspace's session is unavailable: ${session.problem ?? "unknown reason"}` };
    if (session.agentOffered === false) {
      return { kind: "none", reason: "This runner offers no agent to run beside a workspace." };
    }
    if (bindingRef.current?.mode !== "agent") return { kind: "none", reason: NO_SESSION_REASON };
    if (session.agentUnavailable) return { kind: "none", reason: session.agentUnavailable };
    const agent = session.agent;
    const workspace = controller.workspace;
    if (!agent || !workspace || !session.sessionId) return { kind: "starting" };
    return {
      kind: "ready",
      agent: {
        sessionId: session.sessionId,
        baseUrl: agent.url ?? `http://${agent.host}:${agent.port}`,
        ...(agent.token ? { token: agent.token } : {}),
        workspace,
      },
    };
  }, [session]);

  const value = useMemo<RunContextValue>(
    () => ({
      bindWorkspace,
      session,
      acceptSessionTerms,
      retrySession,
      setDesiredApps,
      setTurnActive,
      syncWorkspace,
      syncing,
      sessionAgent,
      appNameOf,
      runIo,
      runApp,
      stopRun,
      reloadRun,
      removeRun,
      clearRunsForApp,
      selectRun,
      runsForApp,
      liveRunForApp,
      latestRunForApp,
      selectedRunForApp,
      isStartingApp,
      blockerForApp,
      showBlocker,
      clearBlocker,
      dockForApp,
      dockHasContent,
      dockFillsPane,
      setDockOpen,
      setDockHeight,
      setDockMaximized,
      forgetApp,
      getTerminal,
    }),
    [
      bindWorkspace,
      session,
      acceptSessionTerms,
      retrySession,
      setDesiredApps,
      setTurnActive,
      syncWorkspace,
      syncing,
      sessionAgent,
      appNameOf,
      runIo,
      runApp,
      stopRun,
      reloadRun,
      removeRun,
      clearRunsForApp,
      selectRun,
      runsForApp,
      liveRunForApp,
      latestRunForApp,
      selectedRunForApp,
      isStartingApp,
      blockerForApp,
      showBlocker,
      clearBlocker,
      dockForApp,
      dockHasContent,
      dockFillsPane,
      setDockOpen,
      setDockHeight,
      setDockMaximized,
      forgetApp,
      getTerminal,
    ],
  );

  return <RunContextValue.Provider value={value}>{children}</RunContextValue.Provider>;
}

interface AppIndex {
  byPath: Map<string, string>;
  byName: Map<string, string>;
  telo: Map<string, string>;
  ports: Map<string, Set<string>>;
}

const EMPTY_APPS: AppIndex = { byPath: new Map(), byName: new Map(), telo: new Map(), ports: new Map() };

const NO_SESSION_REASON =
  "No agent serves this workspace — open it in Agent mode from the workspace menu, or set an agent URL in settings.";

function reportedAfter(
  reported: Record<string, string>,
  app: string,
  telo: string | undefined,
): Record<string, string> {
  const rest = Object.fromEntries(Object.entries(reported).filter(([name]) => name !== app));
  return telo === undefined ? rest : { ...rest, [app]: telo };
}

/** Append debug frames to a record, ring-capped at {@link MAX_DEBUG_FRAMES}. */
function appendDebugFrames(record: RunRecord, frames: DebugFrame[]): RunRecord {
  const combined = [...record.debugFrames, ...frames];
  const overflow = combined.length - MAX_DEBUG_FRAMES;
  return {
    ...record,
    debugFrames: overflow > 0 ? combined.slice(overflow) : combined,
    debugFrameSeq: record.debugFrameSeq + frames.length,
  };
}

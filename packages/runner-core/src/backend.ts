import type { RunnerAgent } from "./config.js";
import type {
  AppState,
  AvailabilityReport,
  ByteStreamTag,
  IoMode,
  PortMapping,
  ProbeConfig,
  RouteState,
  RunnerEndpoint,
  RunPhase,
  RunStatus,
  SessionConfig,
  WorkspaceChangeSet,
  WorkspaceTree,
} from "./contract.js";
import type { SessionContainerEngine } from "./session-containers/session-container-engine.js";

/**
 * The seam between backend-neutral session machinery (routes, registry, store,
 * lifecycle, SSE) and a concrete substrate (kubernetes pods, docker containers,
 * local processes).
 *
 * A session is a WORKSPACE: the backend creates a workload that holds one idle
 * slot per application (a container on the container backends) beside the
 * workspace and an optional agent, and starts nothing in it. A run is a process
 * start inside a slot that already exists (`runApp`). Core owns everything a
 * run means — the argv, the env, the debug relay, the run projection,
 * reachability — and the backend only spawns, signals and reports.
 *
 * Session env never reaches `create`, `setApps` or `setAgent`: it arrives with
 * each `runApp` and lives only in the process running the app.
 */
export interface RunnerBackend {
  /** Report readiness without creating a session. Backs `POST /v1/probe`. */
  probe(config: ProbeConfig): Promise<AvailabilityReport>;

  /** Create a session's workload over its storage (created on first use, kept
   *  across suspend). Resolves once every slot is up and idle, after reporting
   *  `running` through `onStatus` and each app `ready` through `onAppState`;
   *  rejects (`SessionStartError` for a typed stage) when it cannot be. */
  create(spec: WorkloadSpec, callbacks: WorkloadCallbacks): Promise<BackendWorkload>;

  /** Take over the workload a previous runner process left for a session whose
   *  record is `running`. Resolves with it — after reporting `running` and every
   *  app's current state, a live run included — or with `undefined` when it is
   *  gone, which suspends the session. Absent, every such session is suspended
   *  at boot (the local runner, whose workloads never outlive it). */
  adopt?(spec: WorkloadSpec, callbacks: WorkloadCallbacks): Promise<AdoptedWorkload | undefined>;

  /** Delete everything a session holds: its workload if one is left, and its
   *  storage. Called on `DELETE` and when retention purges a suspended
   *  session. A session with nothing left is a no-op. */
  destroy(sessionId: string): Promise<void>;

  /** Make one telo version runnable for an app set about to be created or
   *  replaced, or say why it cannot be: the returned text is the `reason` of a
   *  `400 telo_version_unavailable`. Present on a backend whose runner
   *  advertises `features.teloVersions`. */
  supplyTelo?(version: string, config: SessionConfig): Promise<string | undefined>;

  /** The ports the workload itself binds beside an app set (a supervisor's, an
   *  inspect endpoint's), asked when an app set is created or replaced. An app
   *  declaring one is refused with `400 port_conflict` naming its purpose. */
  reservedPorts?(apps: BackendAppSpec[]): ReservedPort[];

  /** The most apps a session may run, for a backend whose workload has a fixed
   *  number of slots. A larger set is refused with `400 too_many_apps`. */
  readonly maxApps?: number;

  /** Remove what earlier runner processes left behind, run once at boot after
   *  adoption: a workload or storage of a session not in `known`, and a
   *  workload of a known session not in `live`. Storage of a known session is
   *  never touched. */
  reapOrphans?(sessions: { known: ReadonlySet<string>; live: ReadonlySet<string> }): Promise<void>;

  /** Runs the containers a session's workload starts through the engine core
   *  serves it (`RUNNER_SESSION_CONTAINERS`). A runner turning that on over a
   *  backend without one is refused at boot. */
  readonly containers?: SessionContainerEngine;
}

/** One application slot the backend must stand up. */
export interface BackendAppSpec {
  name: string;
  /** Workspace-relative entry path, already traversal-normalized by core. */
  entryRelativePath: string;
  ports: PortMapping[];
  /** The telo version this app runs on, already supplied by `supplyTelo`.
   *  Absent, the backend's own choice runs. */
  telo?: string;
}

/** A port the workload binds for one app's machinery. No app of the set may
 *  declare it, whichever app it is reserved for. */
export interface ReservedPort {
  /** The app it is reserved for; absent for a port every app of the workload shares. */
  app?: string;
  port: number;
  protocol: PortMapping["protocol"];
  /** What binds it, as a refusal names it: `"the session supervisor"`. */
  purpose: string;
}

/** Tokens core minted for one workload creation, already injected into the
 *  env they belong to, and reported by core as `RunnerEndpoint.token`. */
export interface WorkloadTokens {
  /** The co-resident agent's `tokenEnv` value, reported on `status.agent`. */
  agent?: string;
}

/** What a workload is created from. Holds no session env. */
export interface WorkloadSpec {
  sessionId: string;
  /** May be empty: a workspace with no Application yet. */
  apps: BackendAppSpec[];
  /** The resolved catalog entry of the co-resident agent, its `tokenEnv`
   *  already carrying this creation's token. Its operator env goes on the agent
   *  and nowhere else. */
  agent?: RunnerAgent;
  /** Whatever this runner declares on `/v1/capabilities`; opaque to core. */
  config: SessionConfig;
  tokens: WorkloadTokens;
}

/** An adopted workload with the tokens its containers were created with, read
 *  back by the backend — core keeps no token across a restart. */
export interface AdoptedWorkload {
  workload: BackendWorkload;
  tokens: WorkloadTokens;
}

/** The statuses a backend reports; core reports `starting`, `suspended` and
 *  `stopped` itself. */
export type BackendStatus = Extract<RunStatus, { kind: "running" } | { kind: "failed" }>;

export interface WorkloadCallbacks {
  /** `running` once the workload is up (and again when a recreate brings it
   *  back), with the endpoints the app set declares and the agent's; `failed`
   *  when a container of the workload ends or it cannot be recreated — a
   *  container ending is never a run outcome. */
  onStatus(status: BackendStatus): void;
  /** A progress message while the workload comes up. `app` is omitted for
   *  session-scoped provisioning. */
  onProgress(phase: RunPhase, message: string, done?: boolean, app?: string): void;
  /** One app's state: `ready` once its slot is up and after each run ends,
   *  `running` from the moment a run started. Core arms the run's debug relay
   *  and reachability on `running` and ends them on the next `ready`. */
  onAppState(app: string, state: AppState): void;
  /** Bytes the live run of one app wrote. `stream` is `tty` under `io: "tty"`
   *  and `stdout` / `stderr` only where the transport separated them. */
  onOutput(app: string, chunk: Buffer, stream: ByteStreamTag): void;
  /** Whether the cluster's routing layer programmed a published host. */
  onRoute(
    app: string | undefined,
    route: { host: string; port: number; state: RouteState; reason?: string },
  ): void;
  /** An app's routable endpoint set changed after `applyDeclaredPorts`. */
  onEndpoints(
    app: string,
    change: {
      added?: RunnerEndpoint[];
      removed?: RunnerEndpoint[];
      rejected?: Array<{ port: number; reason: string }>;
    },
  ): void;
}

/** Where core reaches one app's slot. */
export interface AppAddresses {
  /** The app's `--inspect` endpoint: `listen` is the address core passes to
   *  `telo run --inspect` (`0.0.0.0:9231`), `url` the debug event stream core
   *  relays from (`http://10.0.0.7:9231/events`). Reachable only by the runner. */
  inspect: { listen: string; url: string };
  /** The host core dials the app's declared tcp ports at for reachability. */
  host: string;
}

/** One run, as core asks for it. */
export interface AppRun {
  /** Minted by core; idempotency key of the run. */
  runId: string;
  /** `telo run --watch --no-input --inspect <listen> --no-open <entry>`.
   *  `argv[0]` is the program name: the backend runs the telo it supplies for
   *  the app's version under it. */
  argv: string[];
  /** The session env of this run. Never written anywhere but the process. */
  env: Record<string, string>;
  /** Workspace-relative working directory (`.` is the workspace root). */
  cwd: string;
  io: IoMode;
  cols?: number;
  rows?: number;
}

/** `runApp` was refused because of the app's run state. */
export class AppRunRefused extends Error {
  constructor(
    public readonly code: "run_active" | "no_run",
    message: string,
  ) {
    super(message);
    this.name = "AppRunRefused";
  }
}

/** A live workload: one per running session. */
export interface BackendWorkload {
  /** The workspace surface: everything outside the workload writes through it,
   *  and a co-resident agent writes the same files directly. */
  readonly workspace: WorkspaceAccess;

  /** Where core reaches an app of the current set. Asked before each run and
   *  for an adopted live one. */
  addresses(app: string): Promise<AppAddresses>;

  /** Start one run in an app's slot. Resolves once the process started (and
   *  `running` was reported through `onAppState`); rejects with `AppRunRefused`
   *  while another run is live, or with the reason a spawn never ran. A
   *  repeated `runId` of the live run resolves again. */
  runApp(app: string, run: AppRun): Promise<void>;

  /** End a live run: SIGTERM to its process group, SIGKILL after `graceMs`.
   *  Resolves once asked; the ending is reported through `onAppState`. A run
   *  that already ended is a no-op. */
  stopApp(app: string, runId: string, graceMs: number): Promise<void>;

  /** Bytes for the live run's stdin; dropped unless `runId` is the live run. */
  writeStdin(app: string, runId: string, bytes: Uint8Array): void;

  /** Resize the live run's pty; dropped unless `runId` is the live run. */
  resize(app: string, runId: string, cols: number, rows: number): void;

  /** Re-run one app with no file change by touching its entry manifest
   *  through the workspace (`POST /v1/sessions/:id/reload`). */
  reload(app: string): Promise<void>;

  /** The declared port set an app's kernel announced on this load
   *  (`Kernel.PortsResolved`). The backend re-routes and reports the change
   *  through `onEndpoints`. */
  applyDeclaredPorts?(app: string, ports: PortMapping[]): void;

  /** Replace the app set. Recreates the workload when its structure changes
   *  (apps added or removed, a telo version or declared ports changed); every
   *  live run ends with it. */
  setApps(apps: BackendAppSpec[]): Promise<void>;

  /** Replace the co-resident agent (its `tokenEnv` already carrying a fresh
   *  token), or remove it. Recreates the workload. */
  setAgent(agent: RunnerAgent | undefined, tokens: WorkloadTokens): Promise<void>;

  /** Delete the workload and keep the session's storage. */
  suspend(): Promise<void>;

  /** The runner process is ending. A backend whose workloads outlive it drops
   *  its connections and stops nothing; one whose workloads cannot (the local
   *  runner) ends them. */
  detach(): Promise<void>;
}

/** The `workspace` surface. Reading and applying a change set are the only two
 *  shapes: a single-file write route would be a second set of concurrency
 *  rules over the same directory. */
export interface WorkspaceAccess {
  tree(): Promise<WorkspaceTree>;
  readFile(path: string): Promise<{ content: string; size: number }>;
  apply(changes: WorkspaceChangeSet): Promise<{ written: number; deleted: number }>;
}

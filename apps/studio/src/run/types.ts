import type { DebugFrame } from "@telorun/debug-wire";
import type { JSONSchema7 } from "json-schema";
import type { RunnerCredentials } from "./runner-credentials";

export interface RunAdapter<Config = unknown> {
  id: string;
  displayName: string;
  description: string;

  configSchema: JSONSchema7;
  defaultConfig: Config;

  validateConfig(config: Config): ConfigIssue[];

  /** Fetch the runner's advertised capabilities (display name + editable config
   *  schema) for the given config. Returns `null` only when the endpoint is
   *  legitimately absent (HTTP 404 — an older runner), so the caller falls back
   *  to the static `configSchema`. THROWS for a real fault — unreachable host,
   *  non-404 HTTP status, or a malformed document — so a misconfiguration is
   *  surfaced rather than masked as "no endpoint". Only adapters that talk to a
   *  self-describing runner implement this. */
  fetchCapabilities?(config: Config): Promise<RunnerCapabilities | null>;

  isAvailable(config: Config): Promise<AvailabilityReport>;

  /** The base URL the runner's HTTP contract is reachable on right now, or
   *  `null` when it isn't. For most adapters this is a config field; the
   *  local-docker adapter resolves it from its supervisor. */
  resolveBaseUrl?(config: Config): Promise<string | null>;

  /** The runner's session surface, at the address it answers on now. Throws,
   *  saying why, when the runner cannot be reached; an adapter whose runner the
   *  editor may start (the local CLI runner) starts it here. */
  connect(config: Config): Promise<RunnerConnection>;

  /** Whether an editor-MANAGED runner is up right now — a separate question
   *  from `isAvailable`, which answers whether this runner can run anything (a
   *  runner the editor starts on demand is available while stopped). Only the
   *  adapters that supervise a local runner implement it; the settings row uses
   *  it to decide whether there is anything to stop. */
  isRunning?(config: Config): Promise<boolean>;

  /** Stop the editor-managed runner, which stops every session it holds. Absent
   *  for a runner the editor does not own: an adapter that dials somebody
   *  else's infrastructure has nothing to tear down. */
  teardown?(config: Config): Promise<void>;
}

/** A runner's self-description, fetched from `GET /v1/capabilities`. Mirrors
 *  `RunnerCapabilities` in `@telorun/runner-core`. */
export interface RunnerCapabilities {
  displayName: string;
  description: string;
  config: {
    schema: JSONSchema7;
    /** The config properties a request leaves out once it names a telo version,
     *  because the runner refuses them beside one. */
    supersededByTelo?: string[];
  };
  /** What this runner offers. `io` lists the byte-channel attach modes a Run
   *  may ask for; `agents` names the catalog entries admissible as a session's
   *  co-resident agent. */
  features: {
    io: IoMode[];
    ports: boolean;
    agents?: string[];
    /** The runner runs each application on the telo version the request names,
     *  or refuses; absent, it is sent none and chooses for itself. */
    teloVersions?: boolean;
  };
  /** Operator-defined usage agreement enforced before a session starts; absent
   *  when the runner has none. */
  terms?: RunnerTerms;
  /** The identity the runner accepts, as RFC 9728 metadata; absent when it
   *  takes resume secrets only. Read as untrusted until checked
   *  (`runner-identity.ts`). */
  identity?: unknown;
}

/** A runner's usage agreement. Mirrors `RunnerTerms` in `@telorun/runner-core`.
 *  `version` is opaque/operator-controlled — a change re-prompts acceptance. */
export interface RunnerTerms {
  version: string;
  title: string;
  body: string;
}

/** How a Run attaches the byte channel (mirrors runner-core's `IoMode`). */
export type IoMode = "tty" | "streams";

/** A runner's refusal of one request, in its own words: `code` is the wire
 *  `error`, `message` what the runner said. */
export class RunnerRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RunnerRefusal";
  }
}

/** Thrown when the runner cannot run an application of the set on the telo
 *  version it names. Nothing was changed; `reason` is the runner's own account
 *  of why, shown to the user as written. */
export class TeloVersionRefusedError extends Error {
  constructor(
    readonly code: "telo_version_unavailable" | "telo_version_unsupported",
    readonly version: string | undefined,
    readonly reason: string,
    readonly app?: string,
  ) {
    super(reason);
    this.name = "TeloVersionRefusedError";
  }
}

/** Thrown by a create when the runner refuses a session because its terms
 *  haven't been acknowledged (HTTP 428). Carries the runner's current terms so
 *  the caller can surface the gate and retry. */
export class TermsRequiredError extends Error {
  constructor(readonly terms: RunnerTerms) {
    super("Runner requires accepting its terms before running.");
    this.name = "TermsRequiredError";
  }
}

/** Thrown when the runner answers that it holds no such session for these
 *  credentials — retention removed it, or it was never this device's. Not a
 *  failure to report: the editor holds the workspace, so the caller creates a
 *  new session and seeds it. */
export class SessionGoneError extends Error {
  constructor() {
    super("The runner no longer holds this session.");
    this.name = "SessionGoneError";
  }
}

export type AvailabilityReport =
  | { status: "ready" }
  | { status: "needs-setup"; issues: ConfigIssue[] }
  | { status: "unavailable"; message: string; remediation?: string; action?: AvailabilityAction };

/** A user-invocable remedy carried on an `unavailable` report — e.g. starting
 *  the editor-managed local runner. `description` spells out the consequences
 *  of invoking it, shown beside the button before the user commits. Surfaces
 *  that render availability reports offer the action generically; no adapter
 *  special-casing. */
export interface AvailabilityAction {
  label: string;
  description: string;
  run(): Promise<void>;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

/** One port an application declares (mirrors runner-core's `PortMapping`). */
export interface SessionPort {
  port: number;
  protocol: "tcp" | "udp";
}

/** One Application of a session's app set (mirrors runner-core's
 *  `SessionAppSpec`). `name` is a DNS label unique in the session. */
export interface SessionAppSpec {
  name: string;
  entryRelativePath: string;
  ports?: SessionPort[];
  telo?: string;
}

/** `POST /v1/sessions`: no files and no env — a new session is seeded through
 *  the workspace surface, and env arrives with each Run. */
export interface CreateSessionRequest {
  workspace: string;
  agent?: string;
  apps: SessionAppSpec[];
}

export type CreatedSession =
  /** `resumeSecret` is answered once, to a create carrying no identity. */
  | { kind: "created"; sessionId: string; resumeSecret?: string }
  /** The owner already has a session for this workspace. */
  | { kind: "exists"; sessionId: string };

/** `POST …/apps/:app/run`. */
export interface RunAppRequest {
  env: Record<string, string>;
  io: IoMode;
  cols?: number;
  rows?: number;
}

/** One app of the session document: its slot's state now. */
export interface SessionAppState {
  name: string;
  entryRelativePath: string;
  ports: SessionPort[];
  telo?: string;
  state: "pending" | "ready" | "running";
  runId?: string;
  io?: IoMode;
  generation: number;
}

/** `GET /v1/sessions/:id`. */
export interface SessionDocument {
  sessionId: string;
  workspace: string;
  status: RunStatus;
  agent: string | null;
  apps: SessionAppState[];
}

/** One of the identity's sessions, as `GET /v1/sessions` lists it. */
export interface ListedSession {
  sessionId: string;
  workspace: string;
  status: RunStatus["kind"];
  lastActiveAt: string;
}

/** What adopting a resume-secret session for the identity came to. */
export type AdoptedSession =
  | { kind: "adopted"; sessionId: string }
  /** The identity already holds a session for that workspace. */
  | { kind: "exists"; sessionId: string }
  /** The secret opens no session: wrong, or the session is gone. */
  | { kind: "gone" };

/** A runner's session surface, at one address. */
export interface RunnerConnection {
  baseUrl: string;
  /** `credentials` names the owner: an identity's create carries it; a create
   *  with none is answered a resume secret. */
  createSession(
    request: CreateSessionRequest,
    options: { acceptedTermsVersion?: string; withheldConfig?: string[]; credentials?: RunnerCredentials },
  ): Promise<CreatedSession>;
  /** The identity's sessions for `workspace`, most recently active first. */
  listSessions(workspace: string, credentials: RunnerCredentials): Promise<ListedSession[]>;
  /** Make a resume-secret session the identity's. */
  adoptSession(sessionId: string, resumeSecret: string, credentials: RunnerCredentials): Promise<AdoptedSession>;
  /** The routes of one session, authorized by `credentials`. */
  session(sessionId: string, credentials: RunnerCredentials): RunnerSession;
}

/**
 * One session — a workspace — on its runner. Every method throws
 * `SessionGoneError` when the runner answers that it holds no such session,
 * `RunnerRefusal` for any other refusal, carrying the runner's own words.
 */
export interface RunnerSession {
  readonly id: string;
  read(): Promise<SessionDocument>;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  setApps(apps: SessionAppSpec[]): Promise<void>;
  setAgent(name: string | null): Promise<void>;
  /** Starts one app; resolves with the run's id. */
  runApp(app: string, request: RunAppRequest): Promise<string>;
  stopApp(app: string): Promise<void>;
  /** Re-runs a live app with no file change. */
  reload(app: string): Promise<void>;
  workspaceTree(): Promise<WorkspaceFileEntry[]>;
  readWorkspaceFile(path: string): Promise<string>;
  applyWorkspace(changes: WorkspaceChangeSet): Promise<void>;
  /** The session's event stream: from its first event, and — opened again,
   *  as after a failed session is resumed — from where the last one ended.
   *  `onClosed` reports a stream that ended without being closed, in words. */
  subscribe(onEvent: (event: RunEvent) => void, onClosed: (reason: string) => void): () => void;
  /** One app's byte channel, from the output after `fromSeq`. */
  io(app: string, fromSeq: number): SequencedRunIo;
}

/** An explicit write/delete list, not a whole-tree replace: a deletion has to be
 *  expressible, and a whole-tree replace can only express it by treating absence
 *  as intent. Mirrors runner-core's `WorkspaceChangeSet`. */
export interface WorkspaceChangeSet {
  write?: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }>;
  delete?: string[];
}

/** One file in a workspace snapshot: its path and the sha256 of its bytes.
 *  Hashing content is what makes two snapshots diff into an exact change set.
 *  Mirrors runner-core's `WorkspaceFileEntry`. */
export interface WorkspaceFileEntry {
  path: string;
  hash: string;
}

/** Which source produced a byte-channel chunk. `tty` under a terminal attach,
 *  where there genuinely is one merged stream; `stdout` / `stderr` only where
 *  the transport really did separate them. The tag never asserts a split that
 *  does not exist. */
export type ByteStreamTag = "tty" | "stdout" | "stderr";

export interface RunIoHandlers {
  onData(bytes: Uint8Array, stream: ByteStreamTag): void;
  onClose(reason: { code: number; clean: boolean }): void;
}

export interface RunIoConnection {
  send(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface RunIo {
  /** Single-shot. Calling `open` more than once for the same `RunIo` is
   *  undefined — implementations may throw or return a no-op connection.
   *  Consumers (TerminalView) key on the `io` instance, so re-mounts pair
   *  with a fresh `RunIo` from the next run. */
  open(handlers: RunIoHandlers): RunIoConnection;
}

/** The highest byte-channel sequence a `RunIo` delivered, so the next run's
 *  channel starts after it. */
export interface SequencedRunIo extends RunIo {
  lastSeq(): number;
}

export interface RunnerEndpoint {
  host: string;
  port: number;
  protocol: "tcp" | "udp";
  /** Fully-qualified URL when the runner already knows it (proxy / ingress);
   *  preferred over deriving `http://host:port`. */
  url?: string;
  /** The per-session token the runner minted for this endpoint's workload, when
   *  its catalog entry declares one; the client presents it as a bearer token. */
  token?: string;
}

/** The SESSION's status, as distinct from how any one run inside it ended: a
 *  one-shot app finishing emits `run.completed` and leaves the session
 *  `running`, and each app reports its own `app` state. Mirrors runner-core's
 *  `RunStatus`. */
export type RunStatus =
  | { kind: "starting" }
  /** `inspectUrl` is the kernel inspection UI fronted by a proxy, set only when
   *  the run used `inspect` and the runner exposes it; absent otherwise.
   *  `agent` is where this session's co-resident agent answers — present only on
   *  a session that asked for one and that the runner could route. */
  | {
      kind: "running";
      endpoints?: RunnerEndpoint[];
      inspectUrl?: string;
      agent?: RunnerEndpoint;
    }
  /** The workload is gone and the session's storage kept: idle, past its
   *  running limit, or suspended by the editor. `resume` rebuilds it under the
   *  same id. Not terminal. */
  | { kind: "suspended" }
  | { kind: "failed"; message: string }
  | { kind: "stopped" };

/** Coarse coming-up phase carried on `progress` events (mirrors runner-core's
 *  `RunPhase`). Additive to status: drives the spinner + step feed while the
 *  session is still `starting`. */
export type RunPhase = "build" | "provision" | "boot";

/** Per-port reachability of the running app's declared ports, watched by the
 *  runner and rendered on the endpoint badge (spinner → ok / error). Mirrors
 *  runner-core's `ReachabilityState`. */
export type RunReachabilityState = "checking" | "reachable" | "unreachable";

/** Whether the runner's cluster actually programmed a published host. A separate
 *  axis from reachability, which only proves the workload is listening: a route
 *  nothing reconciles leaves every port reachable and every URL dead. */
export type RunRouteState = "pending" | "programmed" | "unprogrammed";

/** What started one generation of an application: a Run, a file change under
 *  the app's watcher, or a reload. */
export type RunTrigger = "run" | "watch" | "manual";

/** How one app's run ended, as the process running it reported. */
export interface AppRunEnding {
  runId: string;
  code?: number;
  signal?: string;
  reason?: string;
}

/** One app's slot, reported as the `app` event. */
export type AppState =
  | { state: "ready"; ended?: AppRunEnding }
  | { state: "running"; runId: string };

/** A RUN outcome — one per app per reload generation, distinct from the session
 *  status. `generation` is monotonic per app and starts at 1. */
export type RunOutcomeEvent =
  | {
      type: "run";
      app: string;
      generation: number;
      phase: "started";
      trigger: RunTrigger;
      /** The version the runtime reported for this generation; absent from a
       *  runtime that reports none. */
      telo?: string;
    }
  | {
      type: "run";
      app: string;
      generation: number;
      phase: "completed";
      code: number;
      durationMs?: number;
    }
  | { type: "run"; app: string; generation: number; phase: "failed"; reason: string };

/** Workload output does NOT travel this channel — it goes over the byte channel
 *  (`RunIo`), which exists because per-chunk events are wasteful for high-volume
 *  output. The `stdout` / `stderr` variants this union used to declare were
 *  emitted by nothing: a contract in shape only. */
export type RunEvent =
  | { type: "status"; status: RunStatus }
  /** `app` is absent for session-scoped provisioning (scheduling, image pull)
   *  and present once the message belongs to one application. */
  | { type: "progress"; app?: string; phase: RunPhase; message: string; done?: boolean }
  /** A frame from one app's kernel debug stream (event or log line). The
   *  adapter sources it differently per backend (relayed by a remote runner, or
   *  a direct loopback SSE for the local runner), but the run dock consumes it the
   *  same way regardless. */
  | { type: "debug"; app: string; frame: DebugFrame }
  /** One app's slot changed: up and idle, running a Run, or a run ended. */
  | ({ type: "app"; app: string } & AppState)
  /** Per-port reachability transition, rendered on the badge. */
  | { type: "reachability"; app: string; port: number; state: RunReachabilityState }
  /** A routing-layer verdict for one published host. `reason` is the routing
   *  controller's own words, and is operator-facing: every cause is fixed in the
   *  cluster, not in the manifest. */
  | {
      type: "route";
      app?: string;
      host: string;
      port: number;
      state: RunRouteState;
      reason?: string;
    }
  | RunOutcomeEvent
  /** An app's declared port set changed on reload and the runner re-patched its
   *  routing. Without this the app binds the new port and is unreachable with no
   *  ingress, no error and no event. */
  | {
      type: "endpoints";
      app: string;
      added?: RunnerEndpoint[];
      removed?: RunnerEndpoint[];
      rejected?: Array<{ port: number; reason: string }>;
    };

/** Terminal = the event stream closes on it. `failed` is resumable all the
 *  same: the session's storage is kept. */
export function isTerminal(status: RunStatus): boolean {
  return status.kind === "failed" || status.kind === "stopped";
}

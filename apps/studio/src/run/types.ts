import type { DebugFrame } from "@telorun/debug-wire";
import type { RunEvent as ProtocolRunEvent } from "@telorun/runner-protocol";
import type { JSONSchema7 } from "json-schema";
export {
  isTerminal,
  type AppRunEnding,
  type AppState,
  type ByteStreamTag,
  type ConfigIssue,
  type CreateSessionRequest,
  type IoMode,
  type PortMapping as SessionPort,
  type ReachabilityState as RunReachabilityState,
  type RouteState as RunRouteState,
  type RunAppRequest,
  type RunOutcomeEvent,
  type RunPhase,
  type RunStatus,
  type RunTrigger,
  type RunnerCapabilities,
  type RunnerEndpoint,
  type RunnerTerms,
  type SessionAppSpec,
  type SessionAppState,
  type SessionDocument,
  type SessionSummary as ListedSession,
  type WorkspaceChangeSet,
  type WorkspaceFileEntry,
} from "@telorun/runner-protocol";
import type {
  ConfigIssue,
  IoMode,
  SessionSummary as ListedSession,
  RunStatus,
  RunnerCapabilities,
  RunnerTerms,
  SessionAppSpec,
  SessionDocument,
  CreateSessionRequest,
  RunAppRequest,
  WorkspaceChangeSet,
  WorkspaceFileEntry,
  ByteStreamTag,
} from "@telorun/runner-protocol";
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

;

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

export type CreatedSession =
  /** `resumeSecret` is answered once, to a create carrying no identity. */
  | { kind: "created"; sessionId: string; resumeSecret?: string }
  /** The owner already has a session for this workspace. */
  | { kind: "exists"; sessionId: string };

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

/** The runner's event stream, carrying the kernel's own debug frame type. */
export type RunEvent = ProtocolRunEvent<DebugFrame>;

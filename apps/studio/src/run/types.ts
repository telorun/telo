import type { DebugFrame } from "@telorun/debug-wire";
import type { JSONSchema7 } from "json-schema";
import type { PortMapping } from "../model";

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
   *  local-docker adapter resolves it from its supervisor. Consumers that dial
   *  the runner directly (the authoring agent) use this instead of reading
   *  config shapes. */
  resolveBaseUrl?(config: Config): Promise<string | null>;

  start(request: RunRequest, config: Config): Promise<RunSession>;

  /** Re-establish a session that already exists on the runner, identified by the
   *  `sessionId` persisted in the editor's run index across a page reload.
   *  Reconciles the session's current status, then replays its console output +
   *  inspection events from the start so the rehydrated record is refilled.
   *  Resolves to `null` when the session no longer exists on the runner (evicted
   *  past its TTL, or the runner restarted) — the caller keeps the history entry
   *  but marks it unavailable. Only adapters whose runner outlives the editor
   *  page implement this. */
  attach?(sessionId: string, config: Config): Promise<RunSession | null>;
}

/** A runner's self-description, fetched from `GET /v1/capabilities`. Mirrors
 *  `RunnerCapabilities` in `@telorun/runner-core`. */
export interface RunnerCapabilities {
  displayName: string;
  description: string;
  config: { schema: JSONSchema7 };
  /** What this runner offers. `io` lists the byte-channel attach modes;
   *  `watch` gates the editor's watch-mode entry point — a runner with it off
   *  rejects the field, so the editor must not offer it. `agents` names the
   *  catalog entries admissible as a session's co-resident agent. */
  features: {
    io: Array<"tty" | "streams">;
    ports: boolean;
    watch?: boolean;
    agents?: string[];
  };
  /** Operator-predefined applications the runner can launch by name (mirrors
   *  runner-core's `RunnerAppDescriptor`). The agent entry point shows only
   *  when an app named `authoring-agent` is offered. */
  apps?: Array<{ name: string; title?: string; description?: string }>;
  /** Operator-defined usage agreement enforced before a session starts; absent
   *  when the runner has none. */
  terms?: RunnerTerms;
}

/** A runner's usage agreement. Mirrors `RunnerTerms` in `@telorun/runner-core`.
 *  `version` is opaque/operator-controlled — a change re-prompts acceptance. */
export interface RunnerTerms {
  version: string;
  title: string;
  body: string;
}

/** Thrown by `start` when the runner rejects a session because the terms haven't
 *  been acknowledged (HTTP 428). Carries the runner's current terms so the caller
 *  can surface the gate and retry. */
export class TermsRequiredError extends Error {
  constructor(readonly terms: RunnerTerms) {
    super("Runner requires accepting its terms before running.");
    this.name = "TermsRequiredError";
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

export interface RunRequest {
  bundle: RunBundle;
  env?: Record<string, string>;
  ports?: PortMapping[];
  /** The terms version the user accepted for this runner, sent to the runner so
   *  it lets the session start. Omitted when the runner has no terms. */
  acceptedTermsVersion?: string;
  /** `run` (default) is one run: the session ends when the workload exits.
   *  `watch` makes the session a workspace that runs continuously — saving a
   *  file reloads the kernel instead of starting a new session. Only offered
   *  when the runner advertises `features.watch`. */
  mode?: "run" | "watch";
  /** Catalog name of a co-resident agent to run beside the session's apps, on
   *  the session's own workspace volume. Requires `mode: "watch"` — the runner
   *  rejects the pairing otherwise, since nothing would observe the agent's
   *  writes. Only sent when the runner advertises the name in
   *  `features.agents`. */
  agent?: string;
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

export interface RunBundle {
  entryRelativePath: string;
  files: Array<{ relativePath: string; contents: string }>;
}

export interface RunSession {
  id: string;
  getStatus(): RunStatus;
  subscribe(listener: (event: RunEvent) => void): () => void;
  stop(): Promise<void>;
  /** Live PTY byte channel. Present when the adapter can stream raw terminal
   *  bytes both directions; absent for log-only adapters. */
  io?: RunIo;

  /** True when this session is a workspace that runs continuously. The three
   *  operations below exist only then, so a caller checks one flag rather than
   *  three optional methods. */
  readonly isWatch?: boolean;
  /** Push an edit into the running workspace. The kernel's watcher reloads on
   *  it — this is what makes a save cost a reload rather than a session. */
  syncWorkspace?(changes: WorkspaceChangeSet): Promise<void>;
  /** Content-hash the running workspace. The read half of the same surface: a
   *  co-resident agent writes the volume directly with its own filesystem
   *  tools, so this is how the editor learns what it wrote. */
  workspaceTree?(): Promise<WorkspaceFileEntry[]>;
  /** One file's contents out of the running workspace. */
  readWorkspaceFile?(path: string): Promise<string>;
  /** Re-run with no file change: pressing Run again after a one-shot app
   *  completed is not a change, so `--watch` alone would do nothing. */
  reload?(): Promise<void>;
  /** Bring a suspended session back under the same id. Resolves to `false` when
   *  the runner no longer has it — the editor holds the authoritative workspace,
   *  so the caller starts a fresh session and re-seeds from its own copy. */
  resume?(): Promise<boolean>;
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
   *  with a fresh `RunIo` from the next session. */
  open(handlers: RunIoHandlers): RunIoConnection;
}

export interface RunnerEndpoint {
  host: string;
  port: number;
  protocol: "tcp" | "udp";
  /** Fully-qualified URL when the runner already knows it (proxy / ingress);
   *  preferred over deriving `http://host:port`. */
  url?: string;
}

/** The SESSION's status, as distinct from how any one run inside it ended.
 *  A one-shot app finishing in a watch session emits `run.completed` and leaves
 *  the session `running`; `exited` belongs to a run session, where the session
 *  IS the run. Mirrors runner-core's `RunStatus`. */
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
  | { kind: "exited"; code: number }
  /** Reaped for idleness: the pod/containers are gone, the workspace checkpoint
   *  is held, and `resume` brings the session back under the same id. NOT
   *  terminal — the editor keeps the session and offers to resume. */
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

/** What started one generation of an application. */
export type RunTrigger = "initial" | "watch" | "manual" | "resume";

/** A RUN outcome — one per app per reload generation, distinct from the session
 *  status. `generation` is monotonic per app and starts at 1. */
export type RunOutcomeEvent =
  | { type: "run"; app: string; generation: number; phase: "started"; trigger: RunTrigger }
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
  /** Per-port reachability transition, rendered on the badge. */
  | { type: "reachability"; app: string; port: number; state: RunReachabilityState }
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

export function isTerminal(status: RunStatus): boolean {
  return status.kind === "exited" || status.kind === "failed" || status.kind === "stopped";
}

/** Thrown when a watch session the editor still holds no longer exists on the
 *  runner — its checkpoint was lost to a restart. Not a failure to report: the
 *  editor holds the authoritative workspace, so the caller starts a fresh
 *  session and re-seeds from its own copy. */
export class SessionGoneError extends Error {
  constructor() {
    super("The runner no longer holds this session.");
    this.name = "SessionGoneError";
  }
}

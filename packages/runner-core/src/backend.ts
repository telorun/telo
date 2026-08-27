import type { DebugFrame } from "@telorun/debug-wire";

import type { ResolvedRunnerApp } from "./config.js";
import type {
  AvailabilityReport,
  ByteStreamTag,
  IoMode,
  PortMapping,
  ProbeConfig,
  ReachabilityState,
  RunBundle,
  RunnerEndpoint,
  RunPhase,
  RunStatus,
  SessionConfig,
  SessionMode,
  WorkspaceChangeSet,
  WorkspaceCheckpointFile,
  WorkspaceTree,
} from "./contract.js";

/**
 * The seam between backend-neutral session machinery (routes, registry, SSE)
 * and a concrete workload runtime (docker container, kubernetes pod).
 *
 * Deliberately abstract: a byte-stream out (`onOutput`), a stdin writer
 * (`BackendSession.writeStdin`), a resize signal, and a wait/exit (`done`) —
 * NOT docker's `ReadWriteStream` duplex. The k8s backend serves the same shape
 * over the Pod `attach` subresource; the docker backend adapts its hijacked
 * attach duplex onto it. Bundle delivery is the backend's responsibility too
 * (docker writes a shared-volume workdir; k8s stages the bundle for an
 * initContainer fetch), so the spec carries the raw `bundle` rather than a
 * pre-resolved on-disk path.
 */
export interface RunnerBackend {
  /** Report readiness without starting a session (daemon/cluster reachable,
   *  image pullable, scaffolding present). Backs `POST /v1/probe`. */
  probe(config: ProbeConfig): Promise<AvailabilityReport>;

  /** Spawn the workload and wire it to the supplied callbacks. Resolves once
   *  the workload has started (after a `running` status is emitted); rejects
   *  with `SessionStartError` for any pre-start failure. */
  start(spec: BackendStartSpec): Promise<BackendSession>;

  /** Reap workloads orphaned by a prior runner process, matched by the
   *  backend's own labelling. Run once at boot — the session registry is
   *  in-memory, so a restart otherwise leaks running workloads. */
  reapOrphans?(): Promise<void>;
}

/** One application container the backend must stand up. */
export interface BackendAppSpec {
  name: string;
  /** Bundle-relative entry path, already traversal-normalized by core. Empty for
   *  a self-contained app session, where the image's own entrypoint runs. */
  entryRelativePath: string;
  ports: PortMapping[];
  io: IoMode;
}

/**
 * The DATA half of a workload launch — everything a start needs that is not a
 * callback. Retained on the session entry so `resume` can build a fresh pod
 * under the same session id from the same description, rather than a second,
 * drifting copy of it.
 */
export interface WorkloadLaunch {
  bundle: RunBundle;
  env: Record<string, string>;
  config: SessionConfig;
  /** True for an operator-predefined app session (`POST /v1/apps/:name/sessions`):
   *  `config.image` is self-contained (app + controllers baked in), so the
   *  backend runs the image's own entrypoint and stages no bundle — `bundle`
   *  is an empty placeholder. */
  selfContained: boolean;
  /** When true, launch each app with `--inspect` and relay its kernel debug
   *  stream via `onDebug`. The inspect endpoint stays reachable only by the
   *  runner — never published outward. Always true for a watch session: that
   *  stream is where `run` events are projected from. */
  inspect: boolean;
  /** `run` (one pod, terminal on exit, today's shape) or `watch` (a workspace
   *  volume, `telo run --watch` per app, the pod outliving its runs). */
  mode: SessionMode;
  /** The applications to run, one container each. Never empty — core defaults a
   *  request with no `apps` to a single entry. */
  apps: BackendAppSpec[];
  /** The resolved catalog entry for a co-resident agent container, when one was
   *  requested. Its operator env goes on THAT container and nowhere else — the
   *  credential boundary used to be structural (two pods) and is now a code
   *  invariant (containers in one pod). */
  agent?: ResolvedRunnerApp;
}

export interface BackendStartSpec extends WorkloadLaunch {
  sessionId: string;

  /** Emit a lifecycle status. The backend drives `starting` → `running` →
   *  terminal (`exited`/`failed`/`stopped`), or `suspended` on an idle reap. */
  onStatus(status: RunStatus): void;
  /** Emit a progress message for a coming-up phase (build / provision / boot).
   *  Additive to status — surfaces what's happening while the session is still
   *  `starting`. `app` is omitted for session-scoped provisioning. */
  onProgress(phase: RunPhase, message: string, done?: boolean, app?: string): void;
  /** Bytes from one app's terminal. `stream` is `tty` under a terminal attach
   *  and `stdout`/`stderr` only where the transport genuinely separated them. */
  onOutput(app: string, chunk: Buffer, stream: ByteStreamTag): void;
  /** A frame relayed from one app's kernel debug stream. Only called when
   *  `inspect` is true and the backend has connected to that app's endpoint. */
  onDebug(app: string, frame: DebugFrame): void;
  /** Report a declared port's reachability from the runner network — `checking`
   *  while the workload comes up, then `reachable`, or `unreachable` after a
   *  timeout. Surfaced on the editor's endpoint badge, not the log stream. */
  onReachability(app: string, port: number, state: ReachabilityState): void;
  /** One app's workload ended on its own. A run session's workload ending IS the
   *  session ending, so this is a watch-session concern: under `--watch` a
   *  finished run leaves the container up, and a container that goes away has
   *  died. Reported through the contract rather than by synthesizing a kernel
   *  frame — that stream's contract is "frames relayed from the workload", and a
   *  backend writing into it puts an event on the wire no kernel emitted. */
  onRunEnded(app: string, outcome: { code?: number; reason?: string }): void;
  /** An app's routable endpoint set changed after a reload re-read its declared
   *  ports. */
  onEndpoints(
    app: string,
    change: {
      added?: RunnerEndpoint[];
      removed?: RunnerEndpoint[];
      rejected?: Array<{ port: number; reason: string }>;
    },
  ): void;
  /** True once a user stop / shutdown has been requested — lets the backend
   *  classify a kill as `stopped` rather than `failed`. */
  isUserStopped(): boolean;
}

export interface BackendSession {
  /** Write bytes to one app's stdin. A no-op once that workload has terminated,
   *  so callers need not track liveness. */
  writeStdin(app: string, bytes: Uint8Array): void;

  /** Resize one app's PTY. A no-op for an app running under `io: "streams"` —
   *  the route rejects such a resize before it reaches here. */
  resize(app: string, cols: number, rows: number): void;

  /** Resolves after the workload terminates and its terminal status has been
   *  emitted via `onStatus`. Never rejects — terminal failures surface as a
   *  `failed` status. A watch session's workload outlives its runs, so this
   *  settles only on stop, suspend, or the pod deadline. */
  readonly done: Promise<void>;

  /** Force-stop the workload. Idempotent and safe to call after natural exit
   *  (a backend should treat an already-gone workload as a no-op). */
  stop(): Promise<void>;

  /** The workspace surface, present only on a watch session. Everything outside
   *  the pod writes through here; the agent (inside it) writes the volume with
   *  its own filesystem tools. */
  readonly workspace?: WorkspaceAccess;

  /** Re-run one app with no file change (`POST /v1/sessions/:id/reload`), by
   *  touching its entry manifest through the same path every other write takes.
   *  No signalling into the container, no shared PID namespace, no `exec` — RBAC
   *  is unchanged. Watch sessions only. */
  reload?(app: string): Promise<void>;

  /** Replace the running app set. A pod's container list is fixed at creation,
   *  so this checkpoints, deletes the pod and creates one with the new set —
   *  the suspend/resume path, reused because it has to be. */
  setApps?(apps: BackendAppSpec[]): Promise<void>;

  /** Delete the workload, keeping nothing but what the caller already
   *  checkpointed. `resume` builds a fresh one from that checkpoint. */
  suspend?(): Promise<void>;
}

/** The `workspace` container's routes, proxied by the runner. Reading and
 *  applying a change set are the only two shapes: a single-file write route
 *  would be a second set of concurrency rules over the same directory. */
export interface WorkspaceAccess {
  tree(): Promise<WorkspaceTree>;
  readFile(path: string): Promise<{ content: string; size: number }>;
  apply(changes: WorkspaceChangeSet): Promise<{ written: number; deleted: number }>;
  /** Whole-tree pull for the checkpoint timer and for suspend. Whole tree rather
   *  than a delta log: a manifest workspace is small, and one shape is easier to
   *  reason about than a replay that has to be correct. */
  snapshot(): Promise<WorkspaceCheckpointFile[]>;
}

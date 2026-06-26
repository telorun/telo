import type { DebugFrame } from "@telorun/debug-wire";

import type {
  AvailabilityReport,
  PortMapping,
  ProbeConfig,
  ReachabilityState,
  RunBundle,
  RunPhase,
  RunStatus,
  SessionConfig,
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

export interface BackendStartSpec {
  sessionId: string;
  bundle: RunBundle;
  /** Bundle-relative entry path, already traversal-normalized by core. */
  entryRelativePath: string;
  env: Record<string, string>;
  ports: PortMapping[];
  config: SessionConfig;
  /** When true, launch the workload with `--inspect` and relay its kernel debug
   *  stream via `onDebug`. The inspect endpoint stays reachable only by the
   *  runner — never published outward. */
  inspect: boolean;

  /** Emit a lifecycle status. The backend drives `starting` → `running` →
   *  terminal (`exited`/`failed`/`stopped`). */
  onStatus(status: RunStatus): void;
  /** Emit a progress message for a coming-up phase (build / provision / boot).
   *  Additive to status — surfaces what's happening while the session is still
   *  `starting`, driving the editor's spinner + step feed. */
  onProgress(phase: RunPhase, message: string, done?: boolean): void;
  /** Raw merged stdout/stderr (PTY) bytes from the workload. */
  onOutput(chunk: Buffer): void;
  /** A frame relayed from the workload's kernel debug stream. Only called when
   *  `inspect` is true and the backend has connected to the inspect endpoint. */
  onDebug(frame: DebugFrame): void;
  /** Report a declared port's reachability from the runner network — `checking`
   *  while the workload comes up, then `reachable`, or `unreachable` after a
   *  timeout. Surfaced on the editor's endpoint badge, not the log stream. */
  onReachability(port: number, state: ReachabilityState): void;
  /** True once a user stop / shutdown has been requested — lets the backend
   *  classify a kill as `stopped` rather than `failed`. */
  isUserStopped(): boolean;
}

export interface BackendSession {
  /** Write bytes to the workload's stdin (PTY). A no-op once the workload has
   *  terminated, so callers need not track liveness. */
  writeStdin(bytes: Uint8Array): void;

  /** Resize the workload's PTY. */
  resize(cols: number, rows: number): void;

  /** Resolves after the workload terminates and its terminal status has been
   *  emitted via `onStatus`. Never rejects — terminal failures surface as a
   *  `failed` status. */
  readonly done: Promise<void>;

  /** Force-stop the workload. Idempotent and safe to call after natural exit
   *  (a backend should treat an already-gone workload as a no-op). */
  stop(): Promise<void>;
}

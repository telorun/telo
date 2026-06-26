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

  /** The runner's usage agreement that must be accepted before a session may
   *  start, or `null` when this runner has none (e.g. local development). The
   *  runner enforces it server-side; the editor surfaces it and records the
   *  user's acceptance. Adapters whose runner has no terms concept omit this. */
  getTerms?(config: Config): Promise<RunnerTerms | null>;

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
  /** Advertised by every runner; reserved for future editor use (e.g. hiding
   *  the terminal when `io` is false). Not consumed yet. */
  features: { io: boolean; ports: boolean };
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
  | { status: "unavailable"; message: string; remediation?: string };

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
}

export interface RunIoHandlers {
  onData(bytes: Uint8Array): void;
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

export type RunStatus =
  | { kind: "starting" }
  /** `inspectUrl` is the kernel inspection UI fronted by a proxy, set only when
   *  the run used `inspect` and the runner exposes it; absent otherwise. */
  | { kind: "running"; endpoints?: RunnerEndpoint[]; inspectUrl?: string }
  | { kind: "exited"; code: number }
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

export type RunEvent =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "status"; status: RunStatus }
  | { type: "progress"; phase: RunPhase; message: string; done?: boolean }
  /** A frame from the workload's kernel debug stream (event or log line). The
   *  adapter sources it differently per backend (relayed by a remote runner, or
   *  a direct loopback SSE for the local runner), but RunView consumes it the
   *  same way regardless. */
  | { type: "debug"; frame: DebugFrame }
  /** Per-port reachability transition (keyed by port), rendered on the badge. */
  | { type: "reachability"; port: number; state: RunReachabilityState };

export function isTerminal(status: RunStatus): boolean {
  return status.kind === "exited" || status.kind === "failed" || status.kind === "stopped";
}

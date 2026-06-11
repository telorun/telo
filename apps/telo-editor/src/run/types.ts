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

  start(request: RunRequest, config: Config): Promise<RunSession>;
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
}

export type RunStatus =
  | { kind: "starting" }
  | { kind: "running"; endpoints?: RunnerEndpoint[] }
  | { kind: "exited"; code: number }
  | { kind: "failed"; message: string }
  | { kind: "stopped" };

/** Coarse coming-up phase carried on `progress` events (mirrors runner-core's
 *  `RunPhase`). Additive to status: drives the spinner + step feed while the
 *  session is still `starting`. */
export type RunPhase = "build" | "provision" | "boot";

export type RunEvent =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "status"; status: RunStatus }
  | { type: "progress"; phase: RunPhase; message: string; done?: boolean };

export function isTerminal(status: RunStatus): boolean {
  return status.kind === "exited" || status.kind === "failed" || status.kind === "stopped";
}

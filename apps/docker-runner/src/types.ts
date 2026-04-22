export type PullPolicy = "missing" | "always" | "never";

export interface ProbeConfig {
  image: string;
  pullPolicy: PullPolicy;
}

export interface SessionConfig {
  image: string;
  pullPolicy: PullPolicy;
  registryUrl?: string;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export type AvailabilityReport =
  | { status: "ready" }
  | { status: "needs-setup"; issues: ConfigIssue[] }
  | { status: "unavailable"; message: string; remediation?: string };

export interface RunBundle {
  entryRelativePath: string;
  files: Array<{ relativePath: string; contents: string }>;
}

export type PortProtocol = "tcp" | "udp";

export interface PortMapping {
  port: number;
  protocol: PortProtocol;
}

/** Sent on the wire as part of `RunStatus.running`. The runner does not know
 *  the hostname clients use to reach it, so `host` is emitted empty and the
 *  client adapter fills it from its own baseUrl before surfacing to the UI. */
export interface RunnerEndpoint {
  host: string;
  port: number;
  protocol: PortProtocol;
}

export interface StartSessionRequest {
  bundle: RunBundle;
  env: Record<string, string>;
  ports?: PortMapping[];
  config: SessionConfig;
}

export type RunStatus =
  | { kind: "starting" }
  | { kind: "running"; endpoints?: RunnerEndpoint[] }
  | { kind: "exited"; code: number }
  | { kind: "failed"; message: string }
  | { kind: "stopped" };

export type RunEvent =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "status"; status: RunStatus };

export type StartFailureStage =
  | "pull"
  | "inspect"
  | "daemon"
  | "create"
  | "attach"
  | "start";

export class SessionStartError extends Error {
  constructor(
    public readonly kind: "pull_failed" | "start_failed",
    public readonly stage: StartFailureStage,
    message: string,
    public readonly daemonMessage?: string,
  ) {
    super(message);
    this.name = "SessionStartError";
  }
}

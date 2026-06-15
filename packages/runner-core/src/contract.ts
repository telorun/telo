/**
 * The backend-neutral `/v1` session contract. Every field here is shared by
 * the docker and kubernetes backends and travels over the HTTP+SSE wire to the
 * editor adapter. Backend-specific concerns (how a container/pod is spawned,
 * how the bundle is delivered) live behind the `RunnerBackend` interface.
 */

import type { DebugFrame } from "@telorun/debug-wire";

export type PullPolicy = "missing" | "always" | "never";

/**
 * What a runner advertises about itself on `GET /v1/capabilities`. The editor
 * fetches this to render a generic runner config form — instead of hardcoding
 * per-backend fields — so the runner is the authority on its own config surface.
 * `config.schema` is a JSON Schema describing the editable `SessionConfig` fields
 * (each property carries its own `default`); server-enforced fields are marked
 * `readOnly` with the enforced value as their `default`. `baseUrl` is never in
 * this schema — the client owns it (you need it to reach the runner).
 */
export interface RunnerCapabilities {
  displayName: string;
  description: string;
  config: { schema: JsonSchema };
  features: RunnerFeatures;
  /** A usage agreement the operator requires before a session may start.
   *  Omitted (or undefined) when this runner has no terms — e.g. a local
   *  development runner. The runner ENFORCES it: `POST /v1/sessions` is rejected
   *  with `428 terms_required` unless the client sends `x-telo-accepted-terms`
   *  matching `terms.version`. The editor surfaces it and records acceptance. */
  terms?: RunnerTerms;
}

/** An operator-defined agreement. `version` is opaque and operator-controlled;
 *  bumping it re-prompts every client. `body` is plain text / markdown. */
export interface RunnerTerms {
  version: string;
  title: string;
  body: string;
}

/** HTTP header carrying the accepted terms version on `POST /v1/sessions`. */
export const ACCEPTED_TERMS_HEADER = "x-telo-accepted-terms";

export interface RunnerFeatures {
  /** Runner exposes a live PTY byte channel (`/v1/sessions/:id/io`). */
  io: boolean;
  /** Runner can publish workload ports back to the client. */
  ports: boolean;
}

/** A JSON Schema document, kept structurally open so runner-core need not depend
 *  on a JSON-Schema type package. The editor treats it as `JSONSchema7`. */
export type JsonSchema = Record<string, unknown>;

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

/**
 * Announced on `RunStatus.running`. `host`/`port` describe a directly-dialable
 * endpoint (docker host-port publish); `url` carries a fully-qualified address
 * for backends that front the workload with a proxy/ingress (k8s per-session
 * ingress), where a bare host:port is not reachable. The client adapter fills an
 * empty `host` from its own baseUrl — the runner does not know the hostname the
 * client used to reach it.
 */
export interface RunnerEndpoint {
  host: string;
  port: number;
  protocol: PortProtocol;
  /** Fully-qualified URL when the endpoint is fronted by a proxy/ingress. */
  url?: string;
}

export interface StartSessionRequest {
  bundle: RunBundle;
  env: Record<string, string>;
  ports?: PortMapping[];
  config: SessionConfig;
  /** Request the kernel debug stream. When true the runner launches the
   *  workload with `--inspect`, subscribes to the in-workload inspect endpoint
   *  (reachable only by the runner — never published outward), and relays each
   *  frame to the client as a `debug` {@link RunEvent}. */
  inspect?: boolean;
}

export type RunStatus =
  | { kind: "starting" }
  /** `inspectUrl` is the kernel debug/inspection UI fronted by a proxy (set only
   *  when the session ran with `inspect` and the runner has a public base URL);
   *  absent when the inspect endpoint isn't externally reachable. */
  | { kind: "running"; endpoints?: RunnerEndpoint[]; inspectUrl?: string }
  | { kind: "exited"; code: number }
  | { kind: "failed"; message: string }
  | { kind: "stopped" };

/**
 * Coarse phase a session passes through while coming up, carried on `progress`
 * events. Additive to the status enum: `RunStatus` stays `starting` until the
 * workload is actually up; these messages drive the editor's spinner + step feed.
 */
export type RunPhase = "build" | "provision" | "boot";

export type RunEvent =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "status"; status: RunStatus }
  | { type: "progress"; phase: RunPhase; message: string; done?: boolean }
  /** A frame relayed from the workload's kernel debug stream (kernel event or
   *  log line). Only emitted when the session was started with `inspect`. */
  | { type: "debug"; frame: DebugFrame };

export function isTerminal(status: RunStatus): boolean {
  return status.kind === "exited" || status.kind === "failed" || status.kind === "stopped";
}

/**
 * Stages a session start can fail at. The docker/k8s backends share the
 * vocabulary; not every stage applies to every backend (`pull`/`inspect` are
 * image-availability stages, `create`/`attach`/`start` are workload stages).
 */
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

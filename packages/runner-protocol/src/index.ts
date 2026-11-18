/**
 * The Telo runner protocol: the client-facing `/v1` contract of a runner. The
 * README is the normative spec and `runner-protocol-schema.json` holds every
 * request, response, event and error shape; these types mirror the schema.
 * The Docker Engine subset a runner serves at `/v1/sessions/:id/engine` is
 * referenced by the README, not restated here.
 */

/** A JSON Schema document, kept structurally open. */
export type JsonSchema = Record<string, unknown>;

/** The shape of one frame on a kernel's debug stream, which the debug wire
 *  format (`@telorun/debug-wire`) owns. A runner relays it unjudged, so the
 *  protocol only needs its outline; a consumer that reads frames passes its own
 *  frame type to {@link RunEvent}. */
export type DebugFrameShape = { kind?: string; timestamp: string; [key: string]: unknown };

// ---- Errors -----------------------------------------------------------------

/** The body of every refusal: `error` is the machine code, `message` the
 *  runner's words. A refusal may carry more members beside them. */
export interface RunnerError {
  error: string;
  message: string;
  [extra: string]: unknown;
}

/** `428 terms_required`: the runner's current terms, to accept and retry. */
export interface TermsRequiredBody {
  error: "terms_required";
  terms: RunnerTerms;
}

/** HTTP header carrying the accepted terms version on `POST /v1/sessions`. */
export const ACCEPTED_TERMS_HEADER = "x-telo-accepted-terms";

// ---- Capabilities -----------------------------------------------------------

/** What a runner advertises on `GET /v1/capabilities`. */
export interface RunnerCapabilities {
  displayName: string;
  description: string;
  config: {
    /** A JSON Schema of the editable session config. */
    schema: JsonSchema;
    /** The config properties a request must leave out once it names a telo
     *  version. */
    supersededByTelo?: string[];
  };
  features: RunnerFeatures;
  terms?: RunnerTerms;
  /** Present when the runner accepts identity: its RFC 9728 metadata. */
  identity?: ProtectedResourceMetadata;
}

/** RFC 9728 protected-resource metadata, as far as a runner states it. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  dpop_bound_access_tokens_required: true;
  dpop_signing_alg_values_supported: string[];
}

/** An operator-defined agreement; `version` is opaque. */
export interface RunnerTerms {
  version: string;
  title: string;
  body: string;
}

/** `tty` is one merged stream from a pty; `streams` keeps stdout and stderr
 *  apart. Chosen per Run. */
export type IoMode = "tty" | "streams";

export interface RunnerFeatures {
  io: IoMode[];
  ports: boolean;
  agents?: string[];
  teloVersions?: boolean;
  /** Present when the runner offers shares. */
  shares?: SharesFeature;
}

export interface SharesFeature {
  maxPerOwner: number;
  maxConnectedPerOwner: number;
  retentionSeconds: number;
}

/** `GET /v1/health`. */
export interface HealthResponse {
  ok: true;
  version: string;
}

// ---- Probe ------------------------------------------------------------------

/** The runner's own vocabulary; core checks only that it is an object. */
export type SessionConfig = Record<string, unknown>;
export type ProbeConfig = SessionConfig;

/** `POST /v1/probe`. */
export interface ProbeRequest {
  config?: ProbeConfig;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export type AvailabilityReport =
  | { status: "ready" }
  | { status: "needs-setup"; issues: ConfigIssue[] }
  | { status: "unavailable"; message: string; remediation?: string };

// ---- Sessions ---------------------------------------------------------------

export type PortProtocol = "tcp" | "udp";

export interface PortMapping {
  port: number;
  protocol: PortProtocol;
  /** The hosts of the application's public addresses on this port. */
  publicHosts?: string[];
}

/** One idle application slot of a session, started by Run. */
export interface SessionAppSpec {
  /** Unique within the session; a DNS label. */
  name: string;
  /** Workspace-relative entry manifest. */
  entryRelativePath: string;
  ports?: PortMapping[];
  /** The telo release this app runs on. */
  telo?: string;
}

/** `POST /v1/sessions`. */
export interface CreateSessionRequest {
  workspace: string;
  agent?: string;
  apps: SessionAppSpec[];
  config?: SessionConfig;
}

/** The `201` answer to a create. `resumeSecret` is answered once, only to a
 *  create carrying no identity. */
export interface CreateSessionResponse {
  sessionId: string;
  streamUrl: string;
  createdAt: string;
  resumeSecret?: string;
}

/** One of the caller's sessions, as `GET /v1/sessions` lists it. */
export interface SessionSummary {
  sessionId: string;
  workspace: string;
  status: RunStatus["kind"];
  lastActiveAt: string;
}

/** `GET /v1/sessions`, newest activity first. */
export interface SessionList {
  sessions: SessionSummary[];
}

/** `POST /v1/sessions/:id/owner`. */
export interface AdoptSessionRequest {
  resumeSecret: string;
}

/** `POST /v1/sessions/:id/owner` answer. */
export interface AdoptSessionResponse {
  sessionId: string;
}

/** One app of the session document: its slot's state now. */
export interface SessionAppState {
  name: string;
  entryRelativePath: string;
  ports: PortMapping[];
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
  config: SessionConfig;
  apps: SessionAppState[];
  createdAt: string;
  lastActiveAt: string;
  suspendedAt: string | null;
}

/** `PUT /v1/sessions/:id/apps` answer (`202`). */
export interface SetAppsResponse {
  apps: string[];
}

/** `PUT /v1/sessions/:id/agent` body. */
export interface SetAgentRequest {
  name: string | null;
}

/** `PUT /v1/sessions/:id/agent` answer (`202`). */
export interface SetAgentResponse {
  agent: string | null;
}

/** `POST /v1/sessions/:id/apps/:app/run`. */
export interface RunAppRequest {
  env: Record<string, string>;
  io: IoMode;
  cols?: number;
  rows?: number;
}

/** `POST …/run` answer (`202`). */
export interface RunAppResponse {
  runId: string;
}

/** `POST …/stop` answer (`202`): `runId` is null when nothing was running. */
export interface StopAppResponse {
  runId: string | null;
}

/** `POST …/suspend` and `POST …/resume` answer (`202`). */
export interface SessionIdResponse {
  sessionId: string;
}

/** `POST …/reload` answer (`202`). */
export interface ReloadResponse {
  reloaded: string[];
}

/** `POST /v1/sessions/:id/io-tickets` body. */
export interface IoTicketRequest {
  app: string;
}

/** A single-use ticket for one app's byte channel, valid
 *  {@link IO_TICKET_TTL_MS}. `/io` takes it as `?ticket=`. */
export interface IoTicket {
  ticket: string;
  expiresAt: string;
}

export const IO_TICKET_TTL_MS = 30_000;

/** Close codes of the byte channel (`GET /v1/sessions/:id/io`). */
export const IO_CLOSE = {
  /** No `?ticket=`. */
  ticketRequired: 4401,
  /** An origin the runner does not serve, or a ticket that is unknown, used,
   *  expired, or minted for another session or app. */
  forbidden: 4403,
  /** The session or the app is gone. */
  notFound: 4404,
  /** The session ended and nothing is left to replay. */
  ended: 4410,
} as const;

/** Which stream a byte-channel chunk came from. */
export type ByteStreamTag = "tty" | "stdout" | "stderr";

/** The stream byte of a byte-channel frame `[seq:4 BE][stream:1][payload]`. */
export const BYTE_STREAM_CODES: Readonly<Record<ByteStreamTag, number>> = { tty: 0, stdout: 1, stderr: 2 };

// ---- Workspace --------------------------------------------------------------

export interface WorkspaceFileEntry {
  path: string;
  hash: string;
}

export interface WorkspaceTree {
  files: WorkspaceFileEntry[];
}

/** An explicit write/delete list, so a deletion is expressible. */
export interface WorkspaceChangeSet {
  write?: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }>;
  delete?: string[];
}

export interface WorkspaceApplyResult {
  written: number;
  deleted: number;
}

/** `GET /v1/sessions/:id/workspace/file`. */
export interface WorkspaceFileContent {
  content: string;
  size: number;
}

// ---- Status and events ------------------------------------------------------

export interface RunnerEndpoint {
  host: string;
  port: number;
  protocol: PortProtocol;
  /** Fully-qualified URL when a proxy or ingress fronts the endpoint. */
  url?: string;
  /** The per-session workload token, when the agent's catalog entry declares one. */
  token?: string;
}

/** The SESSION's status, separate from how any one run ended. */
export type RunStatus =
  | { kind: "starting" }
  | { kind: "running"; endpoints?: RunnerEndpoint[]; inspectUrl?: string; agent?: RunnerEndpoint }
  | { kind: "suspended" }
  | { kind: "failed"; message: string }
  | { kind: "stopped" };

/** Terminal = the event stream and the byte channel close on it. */
export function isTerminal(status: RunStatus): boolean {
  return status.kind === "failed" || status.kind === "stopped";
}

export type RunPhase = "build" | "provision" | "boot";
export type ReachabilityState = "checking" | "reachable" | "unreachable";
export type RouteState = "pending" | "programmed" | "unprogrammed";
export type RunTrigger = "run" | "watch" | "manual";

export interface AppRunEnding {
  runId: string;
  code?: number;
  signal?: string;
  reason?: string;
}

export type AppState = { state: "ready"; ended?: AppRunEnding } | { state: "running"; runId: string };

export type RunOutcomeEvent =
  | {
      type: "run";
      app: string;
      generation: number;
      phase: "started";
      trigger: RunTrigger;
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

export type OpenUrlReach = "port" | "unrouted" | "external";

/** One event of `GET /v1/sessions/:id/events`. Clients ignore types they do
 *  not know. Workload output never travels here: it goes over the byte
 *  channel. */
export type RunEvent<Frame = DebugFrameShape> =
  | { type: "status"; status: RunStatus }
  | { type: "progress"; app?: string; phase: RunPhase; message: string; done?: boolean }
  | { type: "debug"; app: string; frame: Frame }
  | { type: "openUrl"; app: string; generation: number; url: string; reach: OpenUrlReach; port?: number }
  | ({ type: "app"; app: string } & AppState)
  | { type: "reachability"; app: string; port: number; state: ReachabilityState }
  | { type: "route"; app?: string; host: string; port: number; state: RouteState; reason?: string }
  | RunOutcomeEvent
  | {
      type: "endpoints";
      app: string;
      added?: RunnerEndpoint[];
      removed?: RunnerEndpoint[];
      rejected?: Array<{ port: number; reason: string }>;
    };

// ---- Shares -----------------------------------------------------------------

/** `POST /v1/shares`: get or create by `name`. */
export interface CreateShareRequest {
  name: string;
  application: string;
}

/** The `201` (new) or `200` (existing) answer of `POST /v1/shares`. */
export interface Share {
  id: string;
  name: string;
  application: string;
  publicUrlTemplate: string;
  publicUrlSecondaryTemplate: string;
  tunnelUrl: string;
}

/** One share of `GET /v1/shares`. */
export interface ShareSummary {
  id: string;
  name: string;
  application: string;
  connected: boolean;
  lastActiveAt: string;
}

/** `GET /v1/shares`, newest activity first. */
export interface ShareList {
  shares: ShareSummary[];
}

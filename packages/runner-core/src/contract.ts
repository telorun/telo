/**
 * The backend-neutral `/v1` session contract. Every field here is shared by
 * every backend and travels over the HTTP+SSE wire to the editor adapter.
 * Backend-specific concerns (how a workload is created, how a run is spawned)
 * live behind the `RunnerBackend` interface.
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
  config: {
    schema: JsonSchema;
    /** The config properties a request must leave out once it names a telo
     *  version, because the version answers what they answered (a container
     *  runner's `image` and `pullPolicy`) — sent beside one, the request is
     *  refused. Stated rather than inferred from `deprecated`, which says a
     *  field is on its way out and nothing about what replaces it. */
    supersededByTelo?: string[];
  };
  features: RunnerFeatures;
  /** A usage agreement the operator requires before a session may start.
   *  Omitted (or undefined) when this runner has no terms — e.g. a local
   *  development runner. The runner ENFORCES it: `POST /v1/sessions` is rejected
   *  with `428 terms_required` unless the client sends `x-telo-accepted-terms`
   *  matching `terms.version`. The editor surfaces it and records acceptance. */
  terms?: RunnerTerms;
  /** Present when the runner accepts identity (`RUNNER_IDENTITY_AUDIENCE` /
   *  `RUNNER_IDENTITY_ISSUERS`): its RFC 9728 protected-resource metadata, the
   *  same document `/.well-known/oauth-protected-resource` serves. A client
   *  checks `resource` against the URL it connects to and never takes it. */
  identity?: ProtectedResourceMetadata;
}

/** RFC 9728 protected-resource metadata, as far as this runner states it. */
export interface ProtectedResourceMetadata {
  /** The runner's canonical https base URL: the token audience and the base
   *  of every DPoP proof's `htu`. */
  resource: string;
  /** The issuers whose access tokens the runner accepts. */
  authorization_servers: string[];
  dpop_bound_access_tokens_required: true;
  dpop_signing_alg_values_supported: string[];
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

/** `POST /v1/sessions/:id/owner`: adopts a resume-secret session for the
 *  identity the request carries. */
export interface AdoptSessionRequest {
  resumeSecret: string;
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

/**
 * How one run's byte channel is attached, chosen per Run.
 *  - `tty`     — one merged stream from a fresh pty, as a terminal produces.
 *                Resize works; `CLICOLOR_FORCE` is injected.
 *  - `streams` — stdout and stderr separated at the source. Resize is rejected
 *                (meaningless with no PTY) and no colour is forced, so the app
 *                sees the environment it would see in production.
 */
export type IoMode = "tty" | "streams";

export interface RunnerFeatures {
  /** Byte-channel attach modes this runner offers (`/v1/sessions/:id/io`). */
  io: IoMode[];
  /** Runner can publish workload ports back to the client. */
  ports: boolean;
  /** The co-resident `agent` a session may name, by its name. Empty/absent
   *  when the operator configured none. */
  agents?: string[];
  /** An application's `telo` version is honoured: the runner runs exactly that
   *  telo or refuses the request (`400 telo_version_unavailable`), never a
   *  substitute. Absent, a request naming a version is refused
   *  (`400 telo_version_unsupported`). */
  teloVersions?: boolean;
}

/** A JSON Schema document, kept structurally open so runner-core need not depend
 *  on a JSON-Schema type package. The editor treats it as `JSONSchema7`. */
export type JsonSchema = Record<string, unknown>;

/**
 * The client-supplied session configuration, opaque to core.
 *
 * It used to be `{ image, pullPolicy }` — container vocabulary in the
 * backend-neutral contract, which only stayed invisible while every backend ran
 * containers. A backend that runs local processes has no image to name, and the
 * repairs that keep the fields (a fake image, a `kind: "process"` branch in
 * core) are both worse than the fields being wrong.
 *
 * The runner is the authority on its own config surface and already says so:
 * `RunnerCapabilities.config.schema` is what the editor renders the form from,
 * and `ServerDeps.validateConfig` is what enforces the same against a client
 * that skipped the editor. A backend narrows this bag to its own shape.
 */
export type SessionConfig = Record<string, unknown>;

/** The same bag, on `POST /v1/probe`. */
export type ProbeConfig = SessionConfig;

export interface ConfigIssue {
  path: string;
  message: string;
}

export type AvailabilityReport =
  | { status: "ready" }
  | { status: "needs-setup"; issues: ConfigIssue[] }
  | { status: "unavailable"; message: string; remediation?: string };

export type PortProtocol = "tcp" | "udp";

export interface PortMapping {
  port: number;
  protocol: PortProtocol;
  /** The hosts of the application's public addresses on this port, as the
   *  kernel announced them (`Kernel.PortsResolved` `publicUrls`) — what a
   *  template-mode host routes beside the port's own host. */
  publicHosts?: string[];
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
  /** The per-session workload token, present when the catalog entry behind this
   *  endpoint declares `tokenEnv`: the value the runner minted for this session
   *  and injected into the workload's env under that name. A client presents it
   *  to the workload (e.g. as a bearer token); the workload decides what it
   *  guards. */
  token?: string;
}

/**
 * One application of a session's app set — one idle container (one directory's
 * process slot on the local runner), started by Run. The multi-app case is two
 * independent Applications, which genuinely cannot be merged (importing a
 * `Telo.Application` is a hard error, so no manifest composes them).
 */
export interface SessionAppSpec {
  /** Unique within the session and usable as a DNS label — it appears in the
   *  container name and in every run event. */
  name: string;
  /** Workspace-relative entry manifest this app runs. */
  entryRelativePath: string;
  /** Ports this app declares. Unique across the WHOLE session: session hosts are
   *  `<port>-<sessionId>.<base-domain>`, a single label, so two apps on one port
   *  would collide with nothing to tell them apart. */
  ports?: PortMapping[];
  /** The telo release this app runs on — a plain version, the one its module
   *  is edited against. Per app, never per session: two applications of one
   *  workspace may resolve to different versions. Omitted, the runner's own
   *  choice runs, as it always did. */
  telo?: string;
}

/** A plain release version, optionally carrying a pre-release and build tag —
 *  what an application's `telo` may name. It becomes an image tag and a release
 *  asset name, so nothing else is admitted. */
export const TELO_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * The oldest telo release a runner supervises.
 *
 * A runner starts an application as `telo run --watch --no-input --inspect <addr>
 * --no-open <entry>` beside a seeded `telo-workspace.yaml`, and reads its run
 * outcomes off the debug stream. A release that predates any of those either
 * fails to start with an error about its own command line, or runs with no
 * generation ever opening — neither of which tells the user the version is
 * simply too old.
 *
 * The floor is the release whose `telo run --watch` takes no hold of its own,
 * so a one-shot application's generation ends — torn down, `Kernel.Stopped`
 * carrying its exit code — and the run is reported `completed`; on an older
 * release that generation never ends until the next edit. It also carries
 * `--no-input` (0.121.0), which every backend passes. It is forward-declared
 * until that release is published, and verified by execution then; raise it
 * only for behaviour a runner starts relying on, and lower it only by running
 * the candidate.
 */
export const MIN_SUPERVISABLE_TELO = "0.123.0";

/** Why `version` is too old to be supervised, or `undefined`. */
export function unsupervisableTelo(version: string): string | undefined {
  const parts = (text: string) => text.split(/[-+]/)[0]!.split(".").map(Number);
  const [asked, floor] = [parts(version), parts(MIN_SUPERVISABLE_TELO)];
  for (let i = 0; i < 3; i++) {
    if (asked[i]! > floor[i]!) return undefined;
    if (asked[i]! < floor[i]!) {
      return (
        `telo ${version} is older than ${MIN_SUPERVISABLE_TELO}, the oldest release a runner ` +
        `is verified to supervise (watch mode and a finished run's outcome, the debug stream, the workspace marker)`
      );
    }
  }
  return undefined;
}

/** Whether a version is a BUILD identity (`X+unreleased`) rather than a release:
 *  a working copy made while `X` was still pending, which no registry and no
 *  release holds under that number. */
export function isUnreleasedTelo(version: string): boolean {
  return version.includes("+");
}

/**
 * `POST /v1/sessions`. A new session holds no files — the client seeds it
 * through `POST /v1/sessions/:id/workspace` — and no env: env arrives with each
 * Run and is held only by the process running the app.
 */
export interface CreateSessionRequest {
  /** The client's opaque name for the workspace. One session per owner and
   *  workspace. */
  workspace: string;
  /** Name of the co-resident agent (`features.agents`). At most
   *  one per session: its unit is the workspace. */
  agent?: string;
  /** Every Application of the workspace, one idle container each. May be empty. */
  apps: SessionAppSpec[];
  /** Whatever this runner's `/v1/capabilities` declares as editable. */
  config?: SessionConfig;
}

/** The `201` answer to a create. `resumeSecret` is present only on a session
 *  created with no identity, and is answered this once: the runner keeps only
 *  its SHA-256, and every session route takes it as `Authorization: Bearer`. */
export interface CreateSessionResponse {
  sessionId: string;
  streamUrl: string;
  createdAt: string;
  resumeSecret?: string;
}

/** `POST /v1/sessions/:id/apps/:app/run`. */
export interface RunAppRequest {
  /** The session env of this run, held only by the process running the app. */
  env: Record<string, string>;
  /** One of `features.io`. */
  io: IoMode;
  /** The terminal's initial size under `tty`. */
  cols?: number;
  rows?: number;
}

/** `POST /v1/sessions/:id/io-tickets`: a single-use ticket for one app's byte
 *  channel, valid {@link IO_TICKET_TTL_MS}. `/io` takes it as `?ticket=`, so no
 *  credential ever appears in a URL. */
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

/**
 * The SESSION's status — how the session itself is doing, not how any one run
 * ended. The two are separate nouns on the same stream: a one-shot app finishing
 * emits `run.completed` and leaves the session `running`, and each app reports
 * its own `app` state.
 */
export type RunStatus =
  | { kind: "starting" }
  /** The workload is up: every application container is ready and idle until
   *  Run. `inspectUrl` is the kernel debug/inspection UI fronted by a proxy, set
   *  only where the runner has a public base URL.
   *
   *  `agent` is where this session's co-resident agent answers, present only on
   *  a session that requested one AND that this runner could route. An ENDPOINT
   *  rather than a URL string because the no-proxy case is real — a docker
   *  runner publishing to the host knows the port and not the hostname the
   *  client reached it by, exactly as for an app's endpoint, so the client
   *  fills an empty `host` from its own base URL. Carried here and not in
   *  `endpoints` because the agent is session infrastructure: `endpoints` are
   *  the ports the APPLICATIONS declared, and merging the two would make an
   *  operator-run container look like part of the user's manifest. */
  | {
      kind: "running";
      endpoints?: RunnerEndpoint[];
      inspectUrl?: string;
      agent?: RunnerEndpoint;
    }
  /** The workload is gone and the session's storage is kept: idle, past its
   *  running limit, or `POST …/suspend`. `POST …/resume` rebuilds it under the
   *  same id. Not terminal. */
  | { kind: "suspended" }
  /** The workload could not be created, or one of its containers ended. What was
   *  left of it is removed and the storage kept, so `resume` rebuilds it. */
  | { kind: "failed"; message: string }
  /** The session was deleted. */
  | { kind: "stopped" };

/**
 * Coarse phase a session passes through while coming up, carried on `progress`
 * events. Additive to the status enum: `RunStatus` stays `starting` until the
 * workload is actually up; these messages drive the editor's spinner + step feed.
 *
 * `build` is kept though no runner in this repo emits it any more: it is the
 * vocabulary a BACKEND reports in, and a backend that materializes an image
 * before boot has a phase to name. A client must render an unknown phase as
 * prose anyway — an older runner is still on the other end of the stream.
 */
export type RunPhase = "build" | "provision" | "boot";

/** Per-port reachability of a running session's declared ports, watched by the
 *  runner from its own network. Drives the editor's endpoint badge
 *  (spinner → ok / error) instead of an app-log line. */
export type ReachabilityState = "checking" | "reachable" | "unreachable";

/**
 * Whether the cluster's routing layer actually PROGRAMMED the public route for a
 * session port — a separate axis from `ReachabilityState`, deliberately.
 *
 * Reachability is the runner dialling the workload's own address; it answers "is
 * the app listening". It says nothing about whether anything routes to it, so a
 * session whose routing objects are reconciled by no controller reports every
 * port `reachable` while every public URL 404s. The two fail independently and
 * want different actions — one is the user's manifest, the other the operator's
 * cluster — so they are two states, not one.
 *
 *  - `pending`      — published, no verdict from the routing layer yet.
 *  - `programmed`   — a controller claimed the route and resolved its backend.
 *  - `unprogrammed` — a controller rejected it, or none claimed it in time.
 */
export type RouteState = "pending" | "programmed" | "unprogrammed";

/** What started one generation of an application.
 *  - `run`    — `POST /v1/sessions/:id/apps/:app/run`
 *  - `watch`  — a file changed under the app's watcher
 *  - `manual` — `POST /v1/sessions/:id/reload` */
export type RunTrigger = "run" | "watch" | "manual";

/** How one app's run ended, as the process running it reported. */
export interface AppRunEnding {
  runId: string;
  code?: number;
  signal?: string;
  /** Why the run never started or was cut off (a spawn that failed, the pod
   *  recreated under it). */
  reason?: string;
}

/** One app's state, reported as the `app` event.
 *  - `ready`   — its container is up and nothing runs, optionally saying how
 *                the run before ended;
 *  - `running` — a Run is live. */
export type AppState =
  | { state: "ready"; ended?: AppRunEnding }
  | { state: "running"; runId: string };

/**
 * A RUN outcome — one per app per reload generation, distinct from the session
 * status above. `generation` is monotonic per app and starts at 1; it is counted
 * by the runner from the kernel lifecycle events already on the debug stream, so
 * it asks the kernel for nothing.
 */
export type RunOutcomeEvent =
  | {
      type: "run";
      app: string;
      generation: number;
      phase: "started";
      trigger: RunTrigger;
      /** The version the runtime itself reported for this generation, passed on
       *  unjudged. Absent from a runtime that reports none. */
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

/**
 * Workload output does NOT travel this channel, in either mode — it goes over the
 * byte channel (`/io`), which exists precisely because per-chunk events are
 * wasteful for high-volume output. The `stdout` / `stderr` variants that used to
 * be declared here were emitted by nothing: a contract in shape only.
 */
export type RunEvent =
  | { type: "status"; status: RunStatus }
  /** `app` is absent for session-scoped provisioning (scheduling, image pull) and
   *  present once the message belongs to one application. */
  | { type: "progress"; app?: string; phase: RunPhase; message: string; done?: boolean }
  /** A kernel event frame relayed from one app's debug stream while it runs. */
  | { type: "debug"; app: string; frame: DebugFrame }
  /** One app's state changed. */
  | ({ type: "app"; app: string } & AppState)
  /** A reachability transition for one declared port of one app. */
  | { type: "reachability"; app: string; port: number; state: ReachabilityState }
  /** A routing-layer verdict for one published host. `app` is absent for a port
   *  that belongs to no application (a co-resident agent's). `reason` carries the
   *  routing controller's own words for a refusal — the operator-facing half,
   *  since every cause here (no controller for the class, a Gateway listener that
   *  does not admit the session namespace) is fixed in the cluster, not the
   *  manifest. */
  | {
      type: "route";
      app?: string;
      host: string;
      port: number;
      state: RouteState;
      reason?: string;
    }
  | RunOutcomeEvent
  /** An app's declared port set changed on reload and the runner re-patched the
   *  Service and its routing objects. Without this the app binds the new port
   *  inside the pod and is simply unreachable: no route, no error, no event. */
  | {
      type: "endpoints";
      app: string;
      added?: RunnerEndpoint[];
      removed?: RunnerEndpoint[];
      /** A declared port that could not be routed (it collides with another app
       *  in this session). Reported, never dropped. */
      rejected?: Array<{ port: number; reason: string }>;
    };

/**
 * Terminal = the event stream and the byte channel close on it. `suspended` is
 * not terminal: the record and the storage outlive the workload. A `failed`
 * session's stream closes, and `resume` still rebuilds it.
 */
export function isTerminal(status: RunStatus): boolean {
  return status.kind === "failed" || status.kind === "stopped";
}

/**
 * Which stream a byte-channel chunk came from. Under `io: "tty"` every chunk is
 * `tty` — the tag never asserts a split that does not exist, which is exactly the
 * failure the deleted `stdout` / `stderr` run events represented.
 */
export type ByteStreamTag = "tty" | "stdout" | "stderr";

/** The stream byte of a byte-channel frame `[seq:4 BE][stream:1][payload]`,
 *  on `/io` and on the session supervisor's channel alike. */
export const BYTE_STREAM_CODES: Readonly<Record<ByteStreamTag, number>> = { tty: 0, stdout: 1, stderr: 2 };

/** One file in a workspace snapshot: its path and the sha256 of its bytes.
 *  Hashing content — rather than comparing sizes or timestamps — is what makes
 *  two snapshots diff into an exact change set. */
export interface WorkspaceFileEntry {
  path: string;
  hash: string;
}

export interface WorkspaceTree {
  files: WorkspaceFileEntry[];
}

/**
 * An explicit write/delete list rather than a whole-tree PUT: a deletion has to
 * be expressible, and a whole-tree PUT can only express it by treating absence as
 * intent. A one-file save is a change set of one — there is deliberately no
 * single-file write route, which would be a second set of concurrency rules.
 */
export interface WorkspaceChangeSet {
  write?: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }>;
  delete?: string[];
}

export interface WorkspaceApplyResult {
  written: number;
  deleted: number;
}

/**
 * Stages a workload creation can fail at. The docker/k8s backends share the
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

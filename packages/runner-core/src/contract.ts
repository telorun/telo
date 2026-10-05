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
  /** Operator-predefined applications this runner can launch by name
   *  (`POST /v1/apps/:name/sessions`). Absent/empty when none are offered —
   *  clients hide the corresponding entry points. */
  apps?: RunnerAppDescriptor[];
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
 * How an application container's byte channel is attached.
 *  - `tty`     — one merged stream, as a terminal produces. Resize works;
 *                `CLICOLOR_FORCE` is injected.
 *  - `streams` — stdout and stderr separated at the source. Resize is rejected
 *                (meaningless with no PTY) and no colour is forced, so the app
 *                sees the environment it would see in production.
 * Nothing is invented at the transport layer: docker's non-TTY attach is already
 * a multiplexed stream carrying a per-frame stream id, and the kubernetes attach
 * subresource without a TTY already gives separate stdout/stderr channels.
 */
export type IoMode = "tty" | "streams";

export interface RunnerFeatures {
  /** Byte-channel attach modes this runner offers (`/v1/sessions/:id/io`). */
  io: IoMode[];
  /** Runner can publish workload ports back to the client. */
  ports: boolean;
  /** Watch sessions (`mode: "watch"`) are requestable. Server-gated: a runner
   *  with watch disabled advertises `false` and rejects the field. */
  watch: boolean;
  /** Catalog names admissible as a session's co-resident `agent`. Empty/absent
   *  when the operator configured none. */
  agents?: string[];
  /** An application's `telo` version is honoured: the runner runs exactly that
   *  telo or refuses the request (`400 telo_version_unavailable`), never a
   *  substitute. Absent, a request naming a version is refused
   *  (`400 telo_version_unsupported`). */
  teloVersions?: boolean;
}

/** An operator-predefined application the runner can launch by name. Only the
 *  identity is advertised — the image and the operator env injected into it
 *  stay server-side, so a client can never pick the image or reach the
 *  secrets. Which apps exist is pure operator configuration (`RUNNER_APPS`);
 *  the runner has no built-in knowledge of any specific app. */
export interface RunnerAppDescriptor {
  /** Wire id: an app session is created via `POST /v1/apps/<name>/sessions`. */
  name: string;
  title?: string;
  description?: string;
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

export interface RunBundle {
  entryRelativePath: string;
  files: Array<{
    relativePath: string;
    contents: string;
    /** `utf8` when omitted. A checkpoint re-seeds a resumed session through this
     *  same shape, and a workspace may hold a binary asset, so dropping anything
     *  that is not text would silently lose a file across a suspend. */
    encoding?: "utf8" | "base64";
  }>;
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
  /** The per-session workload token, present when the catalog entry behind this
   *  endpoint declares `tokenEnv`: the value the runner minted for this session
   *  and injected into the workload's env under that name. A client presents it
   *  to the workload (e.g. as a bearer token); the workload decides what it
   *  guards. */
  token?: string;
}

/**
 * How long a session lives relative to its runs.
 *  - `run`   — one run. The workload exits and the session is terminal. Today's
 *              behaviour, and the default.
 *  - `watch` — a workspace that runs continuously. Each application container
 *              runs `telo run --watch`, an edit costs a kernel reload rather
 *              than a pod, and a completed one-shot run leaves the session up.
 */
export type SessionMode = "run" | "watch";

/** The name a single-app session's one application takes when the request
 *  declares no `apps` — so every `run` / `debug` / `endpoints` event names an
 *  app, and no client needs two readings of the same stream. */
export const DEFAULT_APP_NAME = "app";

/**
 * One application in a session — one container, one kernel, one watcher. Most
 * workspaces have exactly one: an Application with several Services in its
 * `targets:` is still one kernel. The multi-app case is two independent
 * Applications, which genuinely cannot be merged (importing a `Telo.Application`
 * is a hard error, so no manifest composes them).
 */
export interface SessionAppSpec {
  /** Unique within the session and usable as a DNS label — it appears in the
   *  container name and in every run event. */
  name: string;
  /** Bundle-relative entry manifest this app runs. */
  entryRelativePath: string;
  /** Ports this app declares. Unique across the WHOLE session: session hosts are
   *  `<port>-<sessionId>.<base-domain>`, a single label, so two apps on one port
   *  would collide with nothing to tell them apart. */
  ports?: PortMapping[];
  /** Terminal or separated streams; defaults to `tty`. */
  io?: IoMode;
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
 * A runner starts an application as `telo run --watch --inspect <addr> --no-open
 * <entry>` beside a seeded `telo-workspace.yaml`, and reads its run outcomes off
 * the debug stream. A release that predates any of those either fails to start
 * with an error about its own command line, or runs with no generation ever
 * opening — neither of which tells the user the version is simply too old.
 *
 * This is the oldest release VERIFIED BY EXECUTION to do all of it (a watch
 * session on the local runner, whose generation opened; 0.103.2 likewise), not
 * the point where it breaks: nothing older was run. Lower it only by running
 * the candidate.
 */
export const MIN_SUPERVISABLE_TELO = "0.95.0";

/** Why `version` is too old to be supervised, or `undefined`. */
export function unsupervisableTelo(version: string): string | undefined {
  const parts = (text: string) => text.split(/[-+]/)[0]!.split(".").map(Number);
  const [asked, floor] = [parts(version), parts(MIN_SUPERVISABLE_TELO)];
  for (let i = 0; i < 3; i++) {
    if (asked[i]! > floor[i]!) return undefined;
    if (asked[i]! < floor[i]!) {
      return (
        `telo ${version} is older than ${MIN_SUPERVISABLE_TELO}, the oldest release a runner ` +
        `is verified to supervise (watch mode, the debug stream and the workspace marker)`
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

export interface StartSessionRequest {
  bundle: RunBundle;
  env: Record<string, string>;
  ports?: PortMapping[];
  /** The telo version of the one application a request with no `apps` runs —
   *  the same field {@link SessionAppSpec} carries per app. */
  telo?: string;
  /** Whatever this runner's `/v1/capabilities` declares as editable. Omitted
   *  against a runner that declares none. */
  config?: SessionConfig;
  /** Request the kernel debug stream. When true the runner launches the
   *  workload with `--inspect`, subscribes to the in-workload inspect endpoint
   *  (reachable only by the runner — never published outward), and relays each
   *  frame to the client as a `debug` {@link RunEvent}. A watch session always
   *  runs with it on — that stream is where `run` events are projected from. */
  inspect?: boolean;
  /** Defaults to `run`. */
  mode?: SessionMode;
  /** Catalog name of a co-resident agent container. At most one per session,
   *  never per app: the agent's unit is the workspace, and two agents over one
   *  workspace would contend on the same files and split one conversation in
   *  half. Requires `mode: "watch"` — an agent with nothing watching its writes
   *  is a silent no-op. */
  agent?: string;
  /** The applications this session runs, one container each. Omitted, it
   *  defaults to a single app named `app` on the bundle's own entry with the
   *  request's `ports` — so a single-app session is written exactly as before. */
  apps?: SessionAppSpec[];
}

/**
 * The SESSION's status — how the session itself is doing, not how any one run
 * ended. The two are separate nouns on the same stream: a one-shot app finishing
 * in a watch session emits `run.completed` and leaves the session `running`, so
 * the next edit starts that app's next generation.
 *
 * `exited` belongs to a `run` session only, where the session IS the run.
 */
export type RunStatus =
  | { kind: "starting" }
  /** Every application container is up. `inspectUrl` is the kernel
   *  debug/inspection UI fronted by a proxy (set only when the session ran with
   *  `inspect` and the runner has a public base URL); absent when the inspect
   *  endpoint isn't externally reachable.
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
  | { kind: "exited"; code: number }
  /** Reaped for idleness: the pod is gone, the workspace checkpoint is held, and
   *  `POST /v1/sessions/:id/resume` brings it back under the same session id.
   *  NOT terminal — nothing is evicted on it. Best-effort by design: the runner
   *  holds the checkpoint in memory, so a runner restart loses it and the editor
   *  (which holds the authoritative workspace) re-seeds from its own copy. */
  | { kind: "suspended" }
  | { kind: "failed"; message: string }
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
 *  - `initial` — the session came up
 *  - `watch`   — a file changed under the app's watcher
 *  - `manual`  — `POST /v1/sessions/:id/reload`
 *  - `resume`  — a suspended session was brought back, or the app set changed */
export type RunTrigger = "initial" | "watch" | "manual" | "resume";

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
  /** A frame relayed from one app's kernel debug stream (kernel event or log
   *  line). Only emitted when the session was started with `inspect`. */
  | { type: "debug"; app: string; frame: DebugFrame }
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
 * Terminal = the session is over and the registry may schedule eviction.
 * `suspended` is deliberately NOT terminal: the session record and its workspace
 * checkpoint outlive the pod, and `resume` brings it back under the same id.
 */
export function isTerminal(status: RunStatus): boolean {
  return status.kind === "exited" || status.kind === "failed" || status.kind === "stopped";
}

/**
 * Which stream a byte-channel chunk came from. Under `io: "tty"` every chunk is
 * `tty` — the tag never asserts a split that does not exist, which is exactly the
 * failure the deleted `stdout` / `stderr` run events represented.
 */
export type ByteStreamTag = "tty" | "stdout" | "stderr";

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

/** One file of a checkpoint — a tree entry plus the bytes needed to re-seed a
 *  fresh pod. Text stays `utf8`; anything that is not valid text is carried
 *  `base64`, so a binary asset survives a suspend/resume round trip. */
export interface WorkspaceCheckpointFile extends WorkspaceFileEntry {
  content: string;
  encoding: "utf8" | "base64";
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

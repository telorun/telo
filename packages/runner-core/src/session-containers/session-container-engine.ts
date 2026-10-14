/**
 * The seam a container backend implements so core can serve each session a
 * container engine. Core owns the wire (the Docker Engine API subset), the
 * bearer token, the create-field whitelist, the forced labels, the ceiling and
 * session scoping; a backend only runs what it is handed on its own substrate —
 * sibling containers on docker, pods on kubernetes.
 *
 * Every call names the session it acts for. Core has already scoped the
 * container id to that session, so a backend never decides scoping; it uses
 * the session id for what its substrate needs (a label, an owner reference).
 */
export interface SessionContainerEngine {
  /** Answers when the substrate is reachable. */
  ping(): Promise<void>;
  /** Whether `image` can be started without a pull first. */
  hasImage(image: string): Promise<boolean>;
  pullImage(image: string): Promise<void>;
  /** Creates the container without starting it; returns its id. */
  create(sessionId: string, spec: SessionContainerSpec): Promise<string>;
  /** Starts it, resolving once it runs or has already exited. */
  start(sessionId: string, id: string, signal: AbortSignal): Promise<void>;
  inspect(sessionId: string, id: string): Promise<SessionContainerState>;
  /** Its output, ending when the container stops (`follow`) or at once.
   *  Resolves once the output is open, so a container that is gone rejects
   *  before anything is answered. */
  logs(
    sessionId: string,
    id: string,
    options: { follow: boolean; tail?: number },
    signal: AbortSignal,
  ): Promise<AsyncIterable<SessionContainerOutput>>;
  /** Removes it with its volumes. A container already gone is removed. */
  remove(sessionId: string, id: string): Promise<void>;
  /** The session's workload is gone for good: release what the backend holds
   *  for the session beside its containers. Called once, after they are removed. */
  endSession?(sessionId: string): Promise<void>;
}

/** The label core puts on every container a session starts, valued with the
 *  session id. */
export const SESSION_CONTAINER_LABEL = "run.telo.session";

/** One container, as a session asked for it and core admitted it. */
export interface SessionContainerSpec {
  image: string;
  /** Overrides the image's command. */
  cmd?: string[];
  /** Overrides the image's entrypoint. */
  entrypoint?: string[];
  /** `NAME=value` entries. */
  env: string[];
  user?: string;
  /** The tcp ports the container listens on. */
  ports: number[];
  /** The session's own labels plus {@link SESSION_CONTAINER_LABEL}. */
  labels: Record<string, string>;
}

export interface SessionContainerState {
  running: boolean;
  /** Set once the container has exited. */
  exitCode: number | null;
  /** Where the session's workload reaches the container's ports; unset while
   *  the substrate has not assigned one. */
  address?: string;
}

export interface SessionContainerOutput {
  stream: "stdout" | "stderr";
  data: Buffer;
}

/** A spec field the substrate cannot run, answered as a 400 naming it. */
export class SessionContainerFieldRefused extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionContainerFieldRefused";
  }
}

/** The container no longer exists, answered as a 404. */
export class SessionContainerNotFound extends Error {
  constructor(id: string) {
    super(`No such container: ${id}`);
    this.name = "SessionContainerNotFound";
  }
}

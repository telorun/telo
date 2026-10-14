/**
 * The `Container.Engine` contract (normative: `docs/engine-contract.md`).
 *
 * An engine runs containers and answers for them; it decides nothing.
 * Lifecycle, deadlines, readiness, expiry and every error code are
 * `Container.Instance`'s, decided once for every engine. A failure is thrown as
 * it arrives, its message saying what the engine answered.
 *
 * Every method that talks to the engine takes an abort signal last, so a start
 * past its deadline stops waiting at once.
 */
export interface ContainerEngine {
  /** Resolves when the engine answers; rejects when it cannot be reached or
   *  refuses to answer, the message naming where it was looked for. */
  ping(signal?: AbortSignal): Promise<void>;
  /** Whether the engine already holds `image`. */
  hasImage(image: string, signal?: AbortSignal): Promise<boolean>;
  /** Pull `image`; resolves once it is held, rejects when the pull failed. */
  pullImage(image: string, signal?: AbortSignal): Promise<void>;
  /** Create a container (not started); resolves with its id. */
  create(spec: ContainerSpec, signal?: AbortSignal): Promise<string>;
  start(id: string, signal?: AbortSignal): Promise<void>;
  inspect(id: string, signal?: AbortSignal): Promise<ContainerState>;
  /** The container's standard output and standard error, interleaved as text.
   *  With `follow`, the iteration ends when the container stops. */
  logs(id: string, options: ContainerLogOptions, signal?: AbortSignal): AsyncIterable<string>;
  /** Every container, running or not, carrying the label key `label`. */
  list(label: string, signal?: AbortSignal): Promise<ContainerSummary[]>;
  /** Force-remove the container and its anonymous volumes. A container that
   *  no longer exists, or is already being removed, is not a failure. */
  remove(id: string, signal?: AbortSignal): Promise<void>;
}

export interface ContainerSpec {
  image: string;
  command?: readonly string[];
  entrypoint?: readonly string[];
  env: Readonly<Record<string, string>>;
  user?: string;
  /** TCP container ports, each to be bound on the engine's loopback interface
   *  to a port the engine chooses. */
  ports: readonly number[];
  labels: Readonly<Record<string, string>>;
}

export interface ContainerState {
  running: boolean;
  /** The exit code once the container has stopped; `null` while it runs. */
  exitCode: number | null;
  /** The binding the engine reports for each published container port — the
   *  address at which the requester reaches it. A port the engine reports no
   *  binding for is absent. */
  bindings: ReadonlyMap<number, PortBinding>;
}

export interface PortBinding {
  host: string;
  port: number;
}

export interface ContainerLogOptions {
  follow: boolean;
  /** Only the last this many lines. Omitted: every line. */
  tail?: number;
}

export interface ContainerSummary {
  id: string;
  labels: Readonly<Record<string, string>>;
}

const ENGINE_METHODS = [
  "ping",
  "hasImage",
  "pullImage",
  "create",
  "start",
  "inspect",
  "logs",
  "list",
  "remove",
] as const;

/** An engine is recognised by its methods and nothing else — never by its
 *  class, and never by having imported this file. */
export function isContainerEngine(value: unknown): value is ContainerEngine {
  return hasMethods(value, ENGINE_METHODS);
}

/**
 * The `Container.Readiness` contract. Given the container just started,
 * resolves `true` once it is ready, or `false` when the container stopped
 * producing output first (its log stream ended). Stops when `signal` aborts.
 */
export interface ContainerReadiness {
  waitUntilReady(target: ReadinessTarget, signal: AbortSignal): Promise<boolean>;
}

export interface ReadinessTarget {
  /** The container's output from its start, followed until it stops. */
  logs(signal: AbortSignal): AsyncIterable<string>;
}

export function isContainerReadiness(value: unknown): value is ContainerReadiness {
  return hasMethods(value, ["waitUntilReady"]);
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return methods.every((method) => typeof candidate[method] === "function");
}

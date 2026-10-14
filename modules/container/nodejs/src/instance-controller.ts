import {
  RuntimeError,
  durationNanos,
  formatDuration,
  isCelDuration,
  type EffectChain,
  type Inverse,
  type KindRef,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import {
  isContainerEngine,
  isContainerReadiness,
  type ContainerEngine,
  type ContainerReadiness,
  type ContainerSpec,
  type ContainerState,
  type PortBinding,
} from "./container-engine-contract.js";

interface InstanceResource {
  metadata: { name: string; module?: string };
  engine: ContainerEngine | KindRef<ContainerEngine>;
  image: string;
  command?: string[];
  entrypoint?: string[];
  env?: Record<string, string>;
  user?: string;
  ports?: unknown[];
  readiness?: ContainerReadiness | KindRef<ContainerReadiness>;
  startupTimeout?: unknown;
  lifetime: unknown;
}

/** The label every container carries: when it may be removed by anyone, in
 *  Unix seconds. */
export const EXPIRES_LABEL = "run.telo.container.expires";

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const NANOS_PER_MILLISECOND = 1_000_000n;
const LOG_TAIL_LINES = 40;
const UNSPECIFIED_ADDRESSES = new Set(["", "0.0.0.0", "::"]);

/** What a resolved instance offers a `Container.Port`. */
export interface StartedContainer {
  readonly describe: string;
  readonly ports: readonly number[];
  /** The address `port` is reached at; throws before the container is ready. */
  binding(port: number): PortBinding;
}

export function isStartedContainer(value: unknown): value is StartedContainer {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.binding === "function" && Array.isArray(candidate.ports);
}

function milliseconds(value: unknown, describe: () => string): number {
  if (!isCelDuration(value)) throw new Error(`${describe()} must be a duration`);
  return Number(durationNanos(value) / NANOS_PER_MILLISECOND);
}

/**
 * Container.Instance — one container, pulled, created, started and awaited in
 * `init()` as one effect whose inverse force-removes it with its volumes. A
 * Provider has no `run()`: its `init()` is where it becomes what it provides,
 * and every acquisition here is released by that one inverse, on teardown or
 * on a failed start alike.
 */
export class ContainerInstance implements ResourceInstance, StartedContainer {
  readonly describe: string;
  readonly ports: readonly number[];
  private readonly startupTimeoutMs: number;
  private readonly startupTimeoutText: string;
  private readonly lifetimeMs: number;
  private bindings?: ReadonlyMap<number, PortBinding>;

  constructor(
    private readonly resource: InstanceResource,
    private readonly ctx: ResourceContext,
  ) {
    this.describe = `Container.Instance "${resource.metadata.name}"`;
    this.ports = (resource.ports ?? []).map((port) => Number(port));
    this.startupTimeoutMs =
      resource.startupTimeout === undefined
        ? DEFAULT_STARTUP_TIMEOUT_MS
        : milliseconds(resource.startupTimeout, () => `${this.describe}: 'startupTimeout'`);
    this.startupTimeoutText = isCelDuration(resource.startupTimeout)
      ? formatDuration(resource.startupTimeout)
      : `${DEFAULT_STARTUP_TIMEOUT_MS / 1000}s`;
    this.lifetimeMs = milliseconds(resource.lifetime, () => `${this.describe}: 'lifetime'`);
  }

  private get engine(): ContainerEngine {
    return this.ctx.resolveRef(
      this.resource.engine,
      isContainerEngine,
      () => `${this.describe}: 'engine'`,
      "Container.Engine",
    );
  }

  private get readiness(): ContainerReadiness | undefined {
    if (this.resource.readiness === undefined) return undefined;
    return this.ctx.resolveRef(
      this.resource.readiness,
      isContainerReadiness,
      () => `${this.describe}: 'readiness'`,
      "Container.Readiness",
    );
  }

  init(ctx: ResourceContext): EffectChain<void> {
    return ctx.effect("container", () => this.start());
  }

  binding(port: number): PortBinding {
    const binding = this.bindings?.get(port);
    if (!binding) {
      throw new Error(`${this.describe}: port ${port} is read before the container is ready.`);
    }
    return binding;
  }

  snapshot(): Record<string, unknown> {
    return {
      image: this.resource.image,
      ports: [...this.ports],
      envNames: Object.keys(this.resource.env ?? {}),
    };
  }

  /** The start, as an effect body: the container's removal is yielded the
   *  moment it exists, so a failure anywhere after leaves nothing behind. */
  async *start(): AsyncGenerator<Inverse, void, void> {
    const engine = this.engine;
    const readiness = this.readiness;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.startupTimeoutMs);
    const signal = deadline.signal;
    try {
      try {
        await engine.ping(signal);
      } catch (err) {
        if (signal.aborted) throw err;
        throw new RuntimeError(
          "ERR_CONTAINER_ENGINE_UNREACHABLE",
          `${this.describe}: the container engine cannot be reached: ${messageOf(err)}`,
        );
      }
      await this.removeExpired(engine, signal);
      if (!(await engine.hasImage(this.resource.image, signal))) {
        this.ctx.log.info(`${this.describe}: pulling ${this.resource.image}`);
        await engine.pullImage(this.resource.image, signal);
      }
      const id = await engine.create(this.spec(), signal);
      yield () => engine.remove(id);
      await engine.start(id, signal);
      await this.awaitReady(engine, readiness, id, signal);
      const state = await engine.inspect(id, signal);
      if (!state.running) throw await this.exited(engine, id, state, signal);
      this.bindings = this.reachable(state);
    } catch (err) {
      if (err instanceof RuntimeError && err.code.startsWith("ERR_CONTAINER_")) throw err;
      if (signal.aborted) {
        throw new RuntimeError(
          "ERR_CONTAINER_NOT_READY",
          `${this.describe}: ${this.resource.image} was not ready within ` +
            `${this.startupTimeoutText} ` +
            `(the startupTimeout covers pulling, creating, starting and readiness).`,
        );
      }
      throw new RuntimeError(
        "ERR_CONTAINER_START_FAILED",
        `${this.describe}: the engine refused to start ${this.resource.image}: ${messageOf(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private spec(): ContainerSpec {
    const expires = Math.floor((Date.now() + this.lifetimeMs) / 1000);
    return {
      image: this.resource.image,
      ...(this.resource.command ? { command: this.resource.command } : {}),
      ...(this.resource.entrypoint ? { entrypoint: this.resource.entrypoint } : {}),
      env: this.resource.env ?? {},
      ...(this.resource.user ? { user: this.resource.user } : {}),
      ports: this.ports,
      labels: { [EXPIRES_LABEL]: String(expires) },
    };
  }

  /** Containers whose expiry has passed belong to a process that was killed
   *  before it could remove them. */
  private async removeExpired(engine: ContainerEngine, signal: AbortSignal): Promise<void> {
    const now = Date.now() / 1000;
    for (const container of await engine.list(EXPIRES_LABEL, signal)) {
      const expires = Number(container.labels[EXPIRES_LABEL]);
      if (!Number.isFinite(expires) || expires > now) continue;
      this.ctx.log.info(`${this.describe}: removing expired container ${container.id}`);
      await engine.remove(container.id, signal);
    }
  }

  private async awaitReady(
    engine: ContainerEngine,
    readiness: ContainerReadiness | undefined,
    id: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!readiness) return;
    const ready = await readiness.waitUntilReady(
      { logs: (logSignal) => engine.logs(id, { follow: true }, logSignal) },
      signal,
    );
    if (ready) return;
    const state = await engine.inspect(id, signal);
    if (!state.running) throw await this.exited(engine, id, state, signal);
    throw new RuntimeError(
      "ERR_CONTAINER_START_FAILED",
      `${this.describe}: the engine ended the log stream of ${this.resource.image} ` +
        `while it was still running, before it was ready.`,
    );
  }

  /** The exit is the error whatever happens to the output: a tail that cannot
   *  be read within the start's deadline is stated in its place. */
  private async exited(
    engine: ContainerEngine,
    id: string,
    state: ContainerState,
    signal: AbortSignal,
  ): Promise<RuntimeError> {
    let output: string;
    try {
      let tail = "";
      for await (const text of engine.logs(id, { follow: false, tail: LOG_TAIL_LINES }, signal)) {
        tail += text;
      }
      output = `Last output:\n${tail.trimEnd() || "(none)"}`;
    } catch (err) {
      output = signal.aborted
        ? `Its output could not be read within ${this.startupTimeoutText}.`
        : `Its output could not be read: ${messageOf(err)}`;
    }
    return new RuntimeError(
      "ERR_CONTAINER_EXITED",
      `${this.describe}: ${this.resource.image} exited with code ${state.exitCode ?? "unknown"} ` +
        `before it was ready. ${output}`,
    );
  }

  /** The address of every published port, as the engine reports its binding.
   *  No binding, or an unspecified address, means the engine did not honour
   *  the loopback binding it was asked for. */
  private reachable(state: ContainerState): ReadonlyMap<number, PortBinding> {
    for (const port of this.ports) {
      const binding = state.bindings.get(port);
      if (!binding || UNSPECIFIED_ADDRESSES.has(binding.host)) {
        throw new RuntimeError(
          "ERR_CONTAINER_START_FAILED",
          `${this.describe}: the engine reports ` +
            (binding ? `the unspecified address '${binding.host}' for` : "no binding for") +
            ` port ${port}/tcp of ${this.resource.image}, so there is no address to reach it at.`,
        );
      }
    }
    return state.bindings;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function create(
  resource: InstanceResource,
  ctx: ResourceContext,
): Promise<ContainerInstance> {
  return new ContainerInstance(resource, ctx);
}

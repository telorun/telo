import {
  SessionContainerNotFound,
  type SessionContainerEngine,
  type SessionContainerOutput,
  type SessionContainerSpec,
} from "@telorun/runner-core";

/** What the engine reads of a container's inspect. */
export interface InspectedContainer {
  State?: { Running?: boolean; ExitCode?: number; Status?: string };
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

export interface EngineDockerContainer {
  start(): Promise<unknown>;
  inspect(): Promise<InspectedContainer>;
  /** A stream when following, the whole output otherwise — dockerode's shape. */
  logs(options: { follow: true; stdout: true; stderr: true; tail?: number }): Promise<NodeJS.ReadableStream>;
  logs(options: { follow?: false; stdout: true; stderr: true; tail?: number }): Promise<Buffer>;
  remove(options: { force: true; v: true }): Promise<unknown>;
}

export interface EngineCreateOptions {
  Image: string;
  Cmd?: string[];
  Entrypoint?: string[];
  Env: string[];
  User?: string;
  ExposedPorts: Record<string, Record<string, never>>;
  Labels: Record<string, string>;
  HostConfig: { NetworkMode: string };
}

/** The part of the docker client the session container engine uses. */
export interface EngineDockerClient {
  ping(): Promise<unknown>;
  getImage(name: string): { inspect(): Promise<unknown> };
  pull(image: string): Promise<NodeJS.ReadableStream>;
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      onFinished: (err: Error | null, output: unknown[]) => void,
    ): void;
  };
  createContainer(options: EngineCreateOptions): Promise<{ id: string }>;
  getContainer(id: string): EngineDockerContainer;
}

/**
 * A session's containers as siblings on the runner's daemon, joined to the
 * child network the session's own container is on — so the session reaches a
 * container at its address there, and nothing is published on the host. The
 * session label core sets is what the runner's boot sweep removes them by.
 */
export function createDockerSessionContainerEngine(deps: {
  docker: EngineDockerClient;
  childNetwork: string;
}): SessionContainerEngine {
  const { docker, childNetwork } = deps;

  return {
    async ping() {
      await docker.ping();
    },

    async hasImage(image) {
      try {
        await docker.getImage(image).inspect();
        return true;
      } catch (err) {
        if (statusOf(err) === 404) return false;
        throw err;
      }
    },

    async pullImage(image) {
      const stream = await docker.pull(image);
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err) =>
          err ? reject(new Error(`pulling ${image} failed: ${err.message}`)) : resolve(),
        );
      });
    },

    async create(sessionId, spec: SessionContainerSpec) {
      const created = await docker.createContainer({
        Image: spec.image,
        ...(spec.cmd ? { Cmd: spec.cmd } : {}),
        ...(spec.entrypoint ? { Entrypoint: spec.entrypoint } : {}),
        Env: spec.env,
        ...(spec.user ? { User: spec.user } : {}),
        ExposedPorts: Object.fromEntries(spec.ports.map((port) => [`${port}/tcp`, {}])),
        Labels: spec.labels,
        HostConfig: { NetworkMode: childNetwork },
      });
      return created.id;
    },

    async start(sessionId, id) {
      await found(id, () => docker.getContainer(id).start());
    },

    async inspect(sessionId, id) {
      const info = await found(id, () => docker.getContainer(id).inspect());
      const running = info.State?.Running === true;
      const exited = !running && info.State?.Status !== "created";
      const address = info.NetworkSettings?.Networks?.[childNetwork]?.IPAddress;
      return {
        running,
        exitCode: exited ? (info.State?.ExitCode ?? null) : null,
        ...(address ? { address } : {}),
      };
    },

    async logs(sessionId, id, options, signal) {
      const tail = options.tail !== undefined ? { tail: options.tail } : {};
      const container = docker.getContainer(id);
      if (!options.follow) {
        const whole = await found(id, () =>
          container.logs({ follow: false, stdout: true, stderr: true, ...tail }),
        );
        return demultiplex([whole]);
      }
      const stream = (await found(id, () =>
        container.logs({ follow: true, stdout: true, stderr: true, ...tail }),
      )) as NodeJS.ReadableStream & { destroy?: () => void };
      signal.addEventListener("abort", () => stream.destroy?.(), { once: true });
      return demultiplex(stream as AsyncIterable<Buffer>);
    },

    async remove(sessionId, id) {
      try {
        await docker.getContainer(id).remove({ force: true, v: true });
      } catch (err) {
        // 404: already gone. 409: a removal already in progress.
        const status = statusOf(err);
        if (status === 404 || status === 409) return;
        throw err;
      }
    },
  };
}

async function found<T>(id: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (statusOf(err) === 404) throw new SessionContainerNotFound(id);
    throw err;
  }
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : undefined;
}

/** The daemon's log framing read back into chunks: an 8-byte header — stream
 *  id, three zero bytes, a big-endian payload length — before each payload. */
export async function* demultiplex(
  source: AsyncIterable<Buffer | string> | Iterable<Buffer>,
): AsyncIterable<SessionContainerOutput> {
  let pending = Buffer.alloc(0);
  for await (const chunk of source) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    pending = pending.length === 0 ? Buffer.from(bytes) : Buffer.concat([pending, bytes]);
    while (pending.length >= 8) {
      const size = pending.readUInt32BE(4);
      if (pending.length < 8 + size) break;
      yield {
        stream: pending[0] === 2 ? "stderr" : "stdout",
        data: Buffer.from(pending.subarray(8, 8 + size)),
      };
      pending = pending.subarray(8 + size);
    }
  }
}

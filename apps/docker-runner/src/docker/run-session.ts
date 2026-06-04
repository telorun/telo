import type {
  BackendSession,
  PortMapping,
  RunnerEndpoint,
  SessionConfig,
  StartFailureStage,
} from "@telorun/runner-core";
import { SessionStartError } from "@telorun/runner-core";

/** Hijacked attach options accepted by dockerode: with `Tty: true` on the
 *  container, the daemon returns a single duplex stream — bytes flow both
 *  ways, no demux needed. */
export interface AttachOpts {
  stream: true;
  stdin: true;
  stdout: true;
  stderr: true;
  hijack: true;
  logs?: boolean;
}

export interface SessionDockerContainer {
  id: string;
  attach(opts: AttachOpts): Promise<NodeJS.ReadWriteStream>;
  start(): Promise<unknown>;
  kill(opts?: { signal?: string }): Promise<unknown>;
  wait(): Promise<{ StatusCode: number; Error?: { Message: string } | null }>;
  remove(opts?: { force?: boolean }): Promise<unknown>;
  resize(opts: { h: number; w: number }): Promise<unknown>;
}

export interface SessionDockerClient {
  ping(): Promise<unknown>;
  getImage(name: string): { inspect(): Promise<unknown> };
  pull(image: string): Promise<NodeJS.ReadableStream>;
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      onFinished: (err: Error | null, output: unknown[]) => void,
    ): void;
  };
  createContainer(opts: CreateContainerOpts): Promise<SessionDockerContainer>;
  getContainer(name: string): SessionDockerContainer;
}

export interface CreateContainerOpts {
  Image: string;
  name: string;
  Cmd: string[];
  WorkingDir: string;
  Env: string[];
  Tty: boolean;
  OpenStdin: boolean;
  StdinOnce: boolean;
  AttachStdin: boolean;
  AttachStdout: boolean;
  AttachStderr: boolean;
  ExposedPorts?: Record<string, Record<string, never>>;
  HostConfig: {
    Binds: string[];
    AutoRemove: boolean;
    NetworkMode: string;
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort: string }>>;
  };
}

export interface SpawnSessionArgs {
  docker: SessionDockerClient;
  containerName: string;
  image: string;
  pullPolicy: SessionConfig["pullPolicy"];
  entryRelativePath: string;
  workingDir: string;
  env: Record<string, string>;
  ports: PortMapping[];
  bundleVolume: string;
  childNetwork: string;
  onStatus: (status: import("@telorun/runner-core").RunStatus) => void;
  onOutput: (chunk: Buffer) => void;
  isUserStopped: () => boolean;
}

/**
 * Spawns the docker workload and adapts its hijacked-attach duplex onto the
 * backend-neutral `BackendSession` (writeStdin / resize / done / stop). The
 * duplex's readable side feeds `onOutput`; the writable side backs `writeStdin`.
 */
export async function spawnDockerSession(args: SpawnSessionArgs): Promise<BackendSession> {
  await ensureImage(args.docker, args.image, args.pullPolicy);

  const container = await createSessionContainer(args);

  const ptyStream = await attachContainer(container);
  ptyStream.on("data", (chunk: Buffer) => {
    if (chunk.byteLength > 0) args.onOutput(chunk);
  });

  try {
    await container.start();
  } catch (err) {
    await safeRemove(container);
    throw startError("start_failed", "start", err);
  }

  args.onStatus({ kind: "starting" });
  args.onStatus({ kind: "running", endpoints: buildEndpoints(args.ports) });

  const done = container.wait().then(
    (info) => {
      args.onStatus(resolveExitStatus(info, args.isUserStopped()));
      endQuietly(ptyStream);
    },
    (err) => {
      args.onStatus({ kind: "failed", message: `failed to await container: ${errMessage(err)}` });
      endQuietly(ptyStream);
    },
  );

  return {
    writeStdin(bytes) {
      try {
        ptyStream.write(Buffer.from(bytes));
      } catch {
        /* exit task closes the stream; late writes are no-ops */
      }
    },
    resize(cols, rows) {
      container.resize({ h: rows, w: cols }).catch(() => {
        /* container may have exited; daemon 404 is expected */
      });
    },
    done,
    stop: () => stopContainer(container),
  };
}

function endQuietly(stream: NodeJS.WritableStream): void {
  try {
    stream.end();
  } catch {
    /* already ended */
  }
}

export async function ensureImage(
  docker: SessionDockerClient,
  image: string,
  pullPolicy: SessionConfig["pullPolicy"],
): Promise<void> {
  if (pullPolicy === "always") {
    await performPull(docker, image);
    return;
  }

  try {
    await docker.getImage(image).inspect();
    return;
  } catch (err) {
    if (pullPolicy === "never") {
      throw new SessionStartError(
        "pull_failed",
        "inspect",
        `image '${image}' not present locally and pullPolicy is 'never'`,
        errMessage(err),
      );
    }
  }

  await performPull(docker, image);
}

async function performPull(docker: SessionDockerClient, image: string): Promise<void> {
  let stream: NodeJS.ReadableStream;
  try {
    stream = await docker.pull(image);
  } catch (err) {
    throw new SessionStartError("pull_failed", "pull", `failed to start pull of '${image}'`, errMessage(err));
  }

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => {
      if (err) {
        reject(new SessionStartError("pull_failed", "pull", `pull of '${image}' failed`, errMessage(err)));
      } else {
        resolve();
      }
    });
  });
}

async function createSessionContainer(args: SpawnSessionArgs): Promise<SessionDockerContainer> {
  const envArray = [
    "FORCE_COLOR=1",
    "CLICOLOR_FORCE=1",
    ...Object.entries(args.env).map(([k, v]) => `${k}=${v}`),
  ];
  const { exposedPorts, portBindings } = buildPortBindings(args.ports);
  // Tty + OpenStdin + StdinOnce=false + the four Attach* flags yield a hijacked
  // attach duplex carrying the PTY byte stream both ways. Without OpenStdin the
  // container's stdin is detached at /dev/null and user input never reaches it.
  const opts: CreateContainerOpts = {
    Image: args.image,
    name: args.containerName,
    Cmd: [args.entryRelativePath],
    WorkingDir: args.workingDir,
    Env: envArray,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    ...(exposedPorts ? { ExposedPorts: exposedPorts } : {}),
    HostConfig: {
      Binds: [`${args.bundleVolume}:/srv`],
      AutoRemove: true,
      NetworkMode: args.childNetwork,
      ...(portBindings ? { PortBindings: portBindings } : {}),
    },
  };
  try {
    return await args.docker.createContainer(opts);
  } catch (err) {
    throw startError("start_failed", "create", err);
  }
}

function buildPortBindings(ports: PortMapping[]): {
  exposedPorts?: Record<string, Record<string, never>>;
  portBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>>;
} {
  if (ports.length === 0) return {};
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const { port, protocol } of ports) {
    const key = `${port}/${protocol}`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostIp: "", HostPort: String(port) }];
  }
  return { exposedPorts, portBindings };
}

/** Endpoints announced on the `running` status. `host` is left blank — the
 *  runner does not know the hostname clients used; the client adapter fills it
 *  from its configured baseUrl. */
function buildEndpoints(ports: PortMapping[]): RunnerEndpoint[] {
  return ports.map((p) => ({ host: "", port: p.port, protocol: p.protocol }));
}

async function attachContainer(container: SessionDockerContainer): Promise<NodeJS.ReadWriteStream> {
  try {
    return await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
      logs: true,
    });
  } catch (err) {
    await safeRemove(container);
    throw startError("start_failed", "attach", err);
  }
}

function resolveExitStatus(
  info: { StatusCode: number; Error?: { Message: string } | null },
  userStopped: boolean,
): import("@telorun/runner-core").RunStatus {
  if (userStopped) return { kind: "stopped" };
  if (info.Error?.Message) return { kind: "failed", message: info.Error.Message };
  return { kind: "exited", code: info.StatusCode };
}

export async function stopContainer(container: SessionDockerContainer): Promise<void> {
  try {
    await container.kill();
  } catch (err) {
    // If AutoRemove already cleaned up the container after natural exit, the
    // daemon replies with 404 — treat as a no-op.
    if (isDaemon404(err)) return;
    throw err;
  }
}

function isDaemon404(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { statusCode?: number; reason?: string };
  return e.statusCode === 404;
}

async function safeRemove(container: SessionDockerContainer): Promise<void> {
  try {
    await container.remove({ force: true });
  } catch {
    // Container may have been AutoRemove'd or never created past header.
  }
}

function startError(
  kind: "pull_failed" | "start_failed",
  stage: StartFailureStage,
  cause: unknown,
): SessionStartError {
  const msg = errMessage(cause);
  return new SessionStartError(kind, stage, `${kind} at stage '${stage}': ${msg}`, msg);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

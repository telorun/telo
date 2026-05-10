import type {
  PortMapping,
  RunEvent,
  RunStatus,
  RunnerEndpoint,
  SessionConfig,
  StartFailureStage,
} from "../types.js";
import { SessionStartError } from "../types.js";

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
  sessionId: string;
  containerName: string;
  image: string;
  pullPolicy: SessionConfig["pullPolicy"];
  entryRelativePath: string;
  workingDir: string;
  env: Record<string, string>;
  ports: PortMapping[];
  bundleVolume: string;
  childNetwork: string;
  onEvent: (event: RunEvent) => void;
  onByteChunk: (chunk: Buffer) => void;
  /** Fired once after `container.wait()` resolves (or rejects). The route
   *  handler uses this to drop `entry.ptyInput` from the registry — pty
   *  writes from the WS thereafter take the early-return path instead of
   *  failing inside the now-ended duplex. */
  onPtyClosed?: () => void;
  isUserStopped: () => boolean;
}

export interface SpawnResult {
  container: SessionDockerContainer;
  ptyInput: NodeJS.WritableStream;
  exit: Promise<void>;
}

export async function spawnSession(args: SpawnSessionArgs): Promise<SpawnResult> {
  await ensureImage(args.docker, args.image, args.pullPolicy);

  const container = await createSessionContainer(args);

  const ptyStream = await attachContainer(container);
  wirePty(ptyStream, args.onByteChunk);

  try {
    await container.start();
  } catch (err) {
    await safeRemove(container);
    throw startError("start_failed", "start", err);
  }

  args.onEvent({ type: "status", status: { kind: "starting" } });
  args.onEvent({
    type: "status",
    status: { kind: "running", endpoints: buildEndpoints(args.ports) },
  });

  const exit = container.wait().then(
    (info) => {
      const status = resolveExitStatus(info, args.isUserStopped());
      args.onEvent({ type: "status", status });
      // Close stdin on exit so any in-flight WS write rejects fast rather
      // than hanging on a pipe whose far end has already gone away.
      try {
        ptyStream.end();
      } catch {
        /* already ended */
      }
      args.onPtyClosed?.();
    },
    (err) => {
      args.onEvent({
        type: "status",
        status: { kind: "failed", message: `failed to await container: ${errMessage(err)}` },
      });
      try {
        ptyStream.end();
      } catch {
        /* already ended */
      }
      args.onPtyClosed?.();
    },
  );

  return { container, ptyInput: ptyStream, exit };
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
        reject(
          new SessionStartError(
            "pull_failed",
            "pull",
            `pull of '${image}' failed`,
            errMessage(err),
          ),
        );
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
  // Tty + OpenStdin + StdinOnce=false + the four Attach* flags are the
  // dockerode invocation that yields a hijacked attach duplex carrying the
  // PTY byte stream both ways. Without OpenStdin the container's stdin is
  // detached at /dev/null; the hijacked attach's writable side errors on
  // write and the WS handler's catch swallows the error — so user input
  // would simply never reach the container.
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

/** Builds the `ExposedPorts` and `HostConfig.PortBindings` fields Docker's
 *  Engine API uses to publish container ports on the host. Same container port
 *  is bound to the same host port; `HostIp: ""` publishes on all interfaces.
 *  Returns empty/undefined bags when `ports` is empty so the resulting
 *  container spec stays minimal. */
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

/** Produces the endpoints list announced on the `running` status. `host` is
 *  left blank — the runner does not know the hostname clients used to reach
 *  it, so the client adapter fills it from its configured baseUrl before
 *  surfacing to the UI. */
function buildEndpoints(ports: PortMapping[]): RunnerEndpoint[] {
  return ports.map((p) => ({ host: "", port: p.port, protocol: p.protocol }));
}

async function attachContainer(
  container: SessionDockerContainer,
): Promise<NodeJS.ReadWriteStream> {
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

function wirePty(
  ptyStream: NodeJS.ReadWriteStream,
  onByteChunk: (chunk: Buffer) => void,
): void {
  ptyStream.on("data", (chunk: Buffer) => {
    if (chunk.byteLength > 0) onByteChunk(chunk);
  });
  // No tail-flush needed — bytes are stored verbatim, not decoded into
  // strings; an EOF without further bytes is just an EOF.
}

function resolveExitStatus(
  info: { StatusCode: number; Error?: { Message: string } | null },
  userStopped: boolean,
): RunStatus {
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
    // Container may have been AutoRemove'd or never actually created past
    // header — nothing to clean.
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

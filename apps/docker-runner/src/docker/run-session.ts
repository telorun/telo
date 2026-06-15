import type {
  BackendSession,
  DebugFrame,
  PortMapping,
  RunnerEndpoint,
  SessionConfig,
  StartFailureStage,
} from "@telorun/runner-core";
import { relayDebugStream, SessionStartError } from "@telorun/runner-core";

/** Port the workload's `--inspect` server binds inside the container. Reached
 *  by the runner over the child network (`http://<container>:<port>/events`);
 *  never published to a host port — only the runner relays the stream out. */
const INSPECT_PORT = 9230;

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
  sessionId: string;
  image: string;
  pullPolicy: SessionConfig["pullPolicy"];
  entryRelativePath: string;
  workingDir: string;
  env: Record<string, string>;
  ports: PortMapping[];
  publicBaseUrl?: string;
  bundleVolume: string;
  childNetwork: string;
  inspect: boolean;
  onStatus: (status: import("@telorun/runner-core").RunStatus) => void;
  onOutput: (chunk: Buffer) => void;
  onDebug: (frame: DebugFrame) => void;
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
  args.onStatus({
    kind: "running",
    endpoints: buildEndpoints(args.sessionId, args.ports, args.publicBaseUrl),
    inspectUrl: args.inspect ? buildInspectUrl(args.sessionId, args.publicBaseUrl) : undefined,
  });

  // When inspect is on, subscribe to the workload's in-container inspect SSE
  // (reachable by name over the child network, never host-published) and relay
  // each frame out. Connect-retries while the kernel boots are expected, not
  // errors — relayDebugStream polls until the endpoint answers or we abort.
  const debugAbort = new AbortController();
  if (args.inspect) {
    void relayDebugStream({
      url: `http://${args.containerName}:${INSPECT_PORT}/events`,
      onFrame: args.onDebug,
      signal: debugAbort.signal,
    });
  }

  const done = container.wait().then(
    (info) => {
      debugAbort.abort();
      args.onStatus(resolveExitStatus(info, args.isUserStopped()));
      endQuietly(ptyStream);
    },
    (err) => {
      debugAbort.abort();
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
    stop: () => {
      debugAbort.abort();
      return stopContainer(container);
    },
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
  const { exposedPorts, portBindings } = buildPortBindings(args.ports, !args.publicBaseUrl);
  // Tty + OpenStdin + StdinOnce=false + the four Attach* flags yield a hijacked
  // attach duplex carrying the PTY byte stream both ways. Without OpenStdin the
  // container's stdin is detached at /dev/null and user input never reaches it.
  // Inspect appends `--inspect 0.0.0.0:<port> --no-open` to the telo args so the
  // kernel serves its debug stream on the child network. 0.0.0.0 (not the CLI's
  // loopback default) lets the runner reach it across the container boundary.
  const cmd = args.inspect
    ? [args.entryRelativePath, "--inspect", `0.0.0.0:${INSPECT_PORT}`, "--no-open"]
    : [args.entryRelativePath];
  const opts: CreateContainerOpts = {
    Image: args.image,
    name: args.containerName,
    Cmd: cmd,
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

/** Container port config. When `publishToHost` is true (no proxy in front) the
 *  app port is bound to the same host port — the only way to reach it. When a
 *  proxy fronts sessions (RUNNER_PUBLIC_BASE_URL set), host publishing is skipped:
 *  the proxy reaches the container by name over the shared network, so binding
 *  host ports is both redundant and a collision source (two sessions on one port,
 *  leftover containers). The container still listens on its port — `ExposedPorts`
 *  documents it and intra-network reachability needs no binding. */
function buildPortBindings(
  ports: PortMapping[],
  publishToHost: boolean,
): {
  exposedPorts?: Record<string, Record<string, never>>;
  portBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>>;
} {
  if (ports.length === 0) return {};
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const { port, protocol } of ports) {
    const key = `${port}/${protocol}`;
    exposedPorts[key] = {};
    if (publishToHost) portBindings[key] = [{ HostIp: "", HostPort: String(port) }];
  }
  return publishToHost ? { exposedPorts, portBindings } : { exposedPorts };
}

/** Endpoints announced on the `running` status.
 *
 *  Without a public base URL, `host` is left blank — the runner does not know
 *  the hostname clients used; the client adapter fills it from its configured
 *  baseUrl.
 *
 *  With `RUNNER_PUBLIC_BASE_URL` set, each tcp port also gets an absolute `url`
 *  routed through a host-matching proxy (e.g. Caddy) that fronts the session
 *  container by name. The app port and session id ride as a single leading
 *  subdomain label (`<port>-<sessionId>`), because a `*.host` wildcard matches
 *  exactly one label — the proxy splits it back into the upstream
 *  `telo-run-<sessionId>:<port>`. udp ports aren't http-routable, so they keep
 *  the host-less form. */
function buildEndpoints(
  sessionId: string,
  ports: PortMapping[],
  publicBaseUrl: string | undefined,
): RunnerEndpoint[] {
  const base = publicBaseUrl ? new URL(publicBaseUrl) : null;
  return ports.map((p) => {
    if (!base || p.protocol !== "tcp") {
      return { host: "", port: p.port, protocol: p.protocol };
    }
    return {
      host: `${sessionId}.${base.hostname}`,
      port: p.port,
      protocol: p.protocol,
      url: `${base.protocol}//${p.port}-${sessionId}.${base.host}`,
    };
  });
}

/** URL of the kernel inspection UI when proxy-routed. The inspect server listens
 *  on `INSPECT_PORT` inside the container, so it rides the same `<port>-<sessionId>`
 *  wildcard route as app ports — no separate proxy rule. Returns undefined without
 *  a public base URL (the inspect endpoint is then only reachable by the runner). */
function buildInspectUrl(sessionId: string, publicBaseUrl: string | undefined): string | undefined {
  if (!publicBaseUrl) return undefined;
  const base = new URL(publicBaseUrl);
  return `${base.protocol}//${INSPECT_PORT}-${sessionId}.${base.host}`;
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

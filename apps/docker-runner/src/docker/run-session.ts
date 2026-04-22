import { StringDecoder } from "node:string_decoder";
import { PassThrough } from "node:stream";

import type {
  PortMapping,
  RunEvent,
  RunStatus,
  RunnerEndpoint,
  SessionConfig,
  StartFailureStage,
} from "../types.js";
import { SessionStartError } from "../types.js";

export interface SessionDockerContainer {
  id: string;
  attach(opts: {
    stream: true;
    stdout: true;
    stderr: true;
    logs: true;
  }): Promise<NodeJS.ReadableStream>;
  start(): Promise<unknown>;
  kill(opts?: { signal?: string }): Promise<unknown>;
  wait(): Promise<{ StatusCode: number; Error?: { Message: string } | null }>;
  remove(opts?: { force?: boolean }): Promise<unknown>;
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
    demuxStream(
      stream: NodeJS.ReadableStream,
      stdout: NodeJS.WritableStream,
      stderr: NodeJS.WritableStream,
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
  isUserStopped: () => boolean;
}

export interface SpawnResult {
  container: SessionDockerContainer;
  exit: Promise<void>;
}

export async function spawnSession(args: SpawnSessionArgs): Promise<SpawnResult> {
  await ensureImage(args.docker, args.image, args.pullPolicy);

  const container = await createSessionContainer(args);

  const attachStream = await attachContainer(container);
  wireStdio(args.docker, attachStream, args.onEvent);

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
    },
    (err) => {
      args.onEvent({
        type: "status",
        status: { kind: "failed", message: `failed to await container: ${errMessage(err)}` },
      });
    },
  );

  return { container, exit };
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
  const opts: CreateContainerOpts = {
    Image: args.image,
    name: args.containerName,
    Cmd: [args.entryRelativePath],
    WorkingDir: args.workingDir,
    Env: envArray,
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

async function attachContainer(container: SessionDockerContainer): Promise<NodeJS.ReadableStream> {
  try {
    return await container.attach({ stream: true, stdout: true, stderr: true, logs: true });
  } catch (err) {
    await safeRemove(container);
    throw startError("start_failed", "attach", err);
  }
}

function wireStdio(
  docker: SessionDockerClient,
  attachStream: NodeJS.ReadableStream,
  onEvent: (event: RunEvent) => void,
): void {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(attachStream, stdout, stderr);

  pipeToEvents(stdout, "stdout", onEvent);
  pipeToEvents(stderr, "stderr", onEvent);
}

function pipeToEvents(
  stream: NodeJS.ReadableStream,
  type: "stdout" | "stderr",
  onEvent: (event: RunEvent) => void,
): void {
  const decoder = new StringDecoder("utf8");
  stream.on("data", (chunk: Buffer) => {
    const text = decoder.write(chunk);
    if (text.length > 0) onEvent({ type, chunk: text });
  });
  stream.on("end", () => {
    const tail = decoder.end();
    if (tail.length > 0) onEvent({ type, chunk: tail });
  });
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

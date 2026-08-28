import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  BackendAppSpec,
  BackendSession,
  BackendStartSpec,
  ByteStreamTag,
  DebugFrame,
  ResolvedRunnerApp,
  RunnerEndpoint,
  WorkspaceAccess,
} from "@telorun/runner-core";
import {
  portKey,
  portsResolvedFrom,
  relayDebugStream,
  SessionStartError,
  watchReachability,
  workspaceAppManifest,
  WORKSPACE_APP_FILENAME,
  workspaceMarkerWrite,
  WorkspaceClient,
} from "@telorun/runner-core";

import {
  ensureImage,
  stopContainer,
  type CreateContainerOpts,
  type SessionDockerClient,
  type SessionDockerContainer,
  type VolumeMount,
} from "./run-session.js";

/** Where the shared bundle volume is mounted in the runner's OWN containers —
 *  the workspace file service, and every run session. It is the whole volume, so
 *  a container holding it can see every session's files. */
const SRV = "/srv";
/**
 * Where a watch session's workspace is mounted in the containers that are NOT
 * the runner's: the applications, and the co-resident agent. The same path
 * kubernetes uses, so a workspace looks identical on both backends.
 *
 * Scoped to the session's own `workspace` subdirectory rather than the whole
 * volume, which is what makes the two things true that mounting `/srv` made
 * false: one session cannot read another's files, and the runner is not laying
 * a volume over a directory an operator-supplied image may already be using
 * (the authoring agent installs itself under `/srv`). The runner's own siblings
 * of that directory — the file service's manifest and its module cache — fall
 * outside the mount, so they never appear in the user's workspace.
 */
const WORKSPACE_MOUNT = "/workspace";
const WORKSPACE_PORT = 8099;

const INSPECT_PORT = 9230;
const WORKSPACE_READY_TIMEOUT_MS = 120_000;
const POLL_MS = 500;

/**
 * The one mount a session's application and agent containers get: that session's
 * own `workspace` subdirectory of the shared volume, at `/workspace`.
 *
 * The subpath is what makes the mount scoped. Without it the whole volume lands
 * at the target — every session's files, in every container — so the daemon
 * floor that guarantees `Subpath` is honoured is not optional (see
 * `MIN_WATCH_API_VERSION`).
 */
export function sessionWorkspaceMount(volume: string, sessionId: string): VolumeMount {
  return {
    Type: "volume",
    Source: volume,
    Target: WORKSPACE_MOUNT,
    VolumeOptions: { Subpath: `${sessionId}/workspace` },
  };
}

export interface DockerWatchDeps {
  docker: SessionDockerClient;
  /** Wall-clock ceiling for a watch session. Docker has no pod-level
   *  `activeDeadlineSeconds`, so the runner holds the timer — without it the
   *  configured ceiling would be a knob that parses and does nothing. */
  maxTtlSeconds: number;
  /** Runner-visible path of the shared bundle volume. */
  bundleRoot: string;
  /** Daemon-visible volume name to mount into spawned containers. */
  bundleVolume: string;
  childNetwork: string;
  publicBaseUrl?: string;
}

/**
 * A docker watch session. The same shape as the kubernetes one — one workspace,
 * one container per running application, the session outliving its runs — with
 * sibling containers on the child network standing in for containers in a pod,
 * and directories on the shared volume standing in for pod volumes.
 *
 * The workspace, the module caches and the workspace application's own manifest
 * all live under one per-session directory on the shared volume, so every
 * container mounts exactly one volume and sees the same paths.
 */
export async function startDockerWatchSession(
  deps: DockerWatchDeps,
  spec: BackendStartSpec,
): Promise<BackendSession> {
  const sessionRoot = join(deps.bundleRoot, spec.sessionId);
  const workspaceHostDir = join(sessionRoot, "workspace");
  const appHostDir = join(sessionRoot, "workspace-app");
  // The workspace as the FILE SERVICE sees it, through the whole-volume mount it
  // needs in order to reach its own manifest and cache beside it.
  const workspaceDir = `${SRV}/${spec.sessionId}/workspace`;
  // The same directory as the applications and the agent see it: mounted alone,
  // at the path kubernetes uses. Everything a session's own containers are told
  // about the workspace is written in terms of this.
  const appWorkspaceDir = WORKSPACE_MOUNT;
  const appDir = `${SRV}/${spec.sessionId}/workspace-app`;
  // Cache root for the WORKSPACE container only. The app containers have none:
  // their cache is anchored by the marker at the workspace root, which is the
  // whole point. The workspace container needs an explicit one because its
  // manifest lives outside the workspace, so it would never see the marker.
  const cacheDir = `${SRV}/${spec.sessionId}/cache`;

  await mkdir(workspaceHostDir, { recursive: true });
  await mkdir(appHostDir, { recursive: true });
  await writeFile(join(appHostDir, WORKSPACE_APP_FILENAME), workspaceAppManifest(), "utf8");

  await ensureImage(deps.docker, spec.config.image, spec.config.pullPolicy);
  if (spec.agent) await ensureImage(deps.docker, spec.agent.image, spec.agent.pullPolicy);

  let apps = spec.apps;
  const containers = new Map<string, SessionDockerContainer>();
  const streams = new Map<string, NodeJS.ReadWriteStream>();
  const abort = new AbortController();
  // A container going away because WE took it down — a stop, a suspend, or a
  // change to the app set — is not a run failing. Without this the reaper's own
  // teardown is reported as `run.failed`, which is a defect the user is then
  // asked to explain.
  let teardownInProgress = false;
  let userStopped = false;
  let settled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const settle = (status: Parameters<BackendStartSpec["onStatus"]>[0]): void => {
    if (settled) return;
    settled = true;
    spec.onStatus(status);
    resolveDone();
  };

  const containerName = (suffix: string): string => `telo-run-${spec.sessionId}-${suffix}`;

  async function createAndStart(
    name: string,
    opts: Omit<CreateContainerOpts, "name">,
  ): Promise<SessionDockerContainer> {
    let container: SessionDockerContainer;
    try {
      container = await deps.docker.createContainer({ ...opts, name });
    } catch (err) {
      throw new SessionStartError("start_failed", "create", `failed to create ${name}`, message(err));
    }
    return container;
  }

  /** The host config for a container that is NOT the runner's own: it gets the
   *  session's workspace at `/workspace` and no other view of the volume.
   *  `Binds` is empty rather than absent — the field is required, and an empty
   *  list is the honest statement that this container binds nothing whole. */
  function sessionHostConfig(
    // Deliberately NOT `Partial<HostConfig>`: spread after `Mounts`, that would
    // let a caller pass `Mounts` or `Binds` and quietly restore the whole-volume
    // view this function exists to close. Port bindings are all any caller needs.
    extra?: Pick<CreateContainerOpts["HostConfig"], "PortBindings">,
  ): CreateContainerOpts["HostConfig"] {
    return {
      Binds: [],
      AutoRemove: true,
      NetworkMode: deps.childNetwork,
      Mounts: [sessionWorkspaceMount(deps.bundleVolume, spec.sessionId)],
      ...extra,
    };
  }

  function baseOpts(overrides: Partial<CreateContainerOpts>): Omit<CreateContainerOpts, "name"> {
    return {
      Image: spec.config.image,
      Env: [],
      Tty: false,
      OpenStdin: false,
      StdinOnce: false,
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: [`${deps.bundleVolume}:${SRV}`],
        AutoRemove: true,
        NetworkMode: deps.childNetwork,
      },
      ...overrides,
    } as Omit<CreateContainerOpts, "name">;
  }

  // --- workspace container ---------------------------------------------------
  const workspaceName = containerName("workspace");
  const workspace = await createAndStart(
    workspaceName,
    baseOpts({
      Cmd: ["telo", "run", `${appDir}/${WORKSPACE_APP_FILENAME}`],
      WorkingDir: workspaceDir,
      Env: [
        `PORT=${WORKSPACE_PORT}`,
        `WORKSPACE_DIR=${workspaceDir}`,
        `TELO_CACHE_DIR=${cacheDir}/workspace`,
      ],
    }),
  );
  containers.set("workspace", workspace);
  await workspace.start();

  const client = new WorkspaceClient(`http://${workspaceName}:${WORKSPACE_PORT}`);
  spec.onProgress("boot", "Starting workspace");
  await waitForWorkspace(client, abort.signal);

  // The bundle reaches the volume through the same surface every later write
  // takes. App containers wait for their entry manifest before starting, so no
  // app has failed a load in the meantime.
  await client.apply({
    write: [
      ...spec.bundle.files.map((f) => ({
        path: f.relativePath,
        content: f.contents,
        encoding: f.encoding ?? "utf8",
      })),
      // The workspace-root marker, so every app in this session anchors its
      // module cache at ONE place instead of one per entry directory.
      ...workspaceMarkerWrite(spec.bundle),
    ],
  });

  // --- application containers ------------------------------------------------
  await startAppContainers();

  // --- agent container -------------------------------------------------------
  if (spec.agent) await startAgentContainer(spec.agent);

  spec.onStatus({ kind: "running", endpoints: endpointsFor(apps), ...agentStatusField() });

  // The session's wall-clock ceiling. `unref`'d: a pending deadline must not be
  // a reason for the runner process to stay alive.
  const deadline = setTimeout(() => {
    if (settled) return;
    teardownInProgress = true;
    void stopAll().finally(() =>
      settle({ kind: "failed", message: "watch session reached its time limit" }),
    );
  }, deps.maxTtlSeconds * 1000);
  deadline.unref?.();

  return {
    writeStdin(app, bytes) {
      try {
        streams.get(app)?.write(Buffer.from(bytes));
      } catch {
        /* stream ended */
      }
    },
    resize(app, cols, rows) {
      containers.get(app)?.resize({ h: rows, w: cols }).catch(() => {
        /* container may have exited; daemon 404 is expected */
      });
    },
    done,
    get workspace(): WorkspaceAccess {
      return client;
    },
    async reload(app) {
      const target = apps.find((a) => a.name === app);
      if (!target) return;
      await client.touch(target.entryRelativePath);
    },
    async setApps(next) {
      teardownInProgress = true;
      // Containers, unlike pod containers, could in principle be added one at a
      // time — but the contract is one path for changing the app set, so this
      // takes the same one the kubernetes backend must take. A second shape
      // would mean the editor observing a different sequence per backend.
      for (const app of apps) await removeContainer(app.name);
      teardownInProgress = false;
      apps = next;
      await startAppContainers();
      spec.onStatus({ kind: "running", endpoints: endpointsFor(apps), ...agentStatusField() });
    },
    async suspend() {
      teardownInProgress = true;
      await stopAll();
    },
    async stop() {
      teardownInProgress = true;
      userStopped = true;
      await stopAll();
      settle({ kind: "stopped" });
    },
  };

  async function startAppContainers(): Promise<void> {
    const aliasOwner = resolveAliasOwner();
    for (const [index, app] of apps.entries()) {
      const tty = app.io === "tty";
      const env = [
        ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        // Deliberately NO `TELO_CACHE_DIR`: it OUTRANKS the workspace marker,
        // and the marker is what puts every app's cache in one place. The kernel
        // walks up from the entry manifest to `telo-workspace.yaml` (seeded at
        // the workspace root when the session starts) and anchors `.telo` there,
        // so two apps importing the same module resolve it once between them.
        `TELO_ENTRY=${appWorkspaceDir}/${app.entryRelativePath}`,
        `TELO_INSPECT_ADDR=0.0.0.0:${INSPECT_PORT + index}`,
      ];
      // Only under a terminal — forcing colour in a mode whose whole purpose is
      // "show me what production sees" defeats the mode.
      if (tty) env.push("CLICOLOR_FORCE=1");

      const { exposedPorts, portBindings } = portConfig(app, !deps.publicBaseUrl);
      const name = containerName(`app-${app.name}`);
      const container = await createAndStart(
        name,
        baseOpts({
          Cmd: [
            "sh",
            "-c",
            'while [ ! -f "$TELO_ENTRY" ]; do sleep 0.2; done; ' +
              'exec telo run "$TELO_ENTRY" --watch --inspect "$TELO_INSPECT_ADDR" --no-open',
          ],
          WorkingDir: appWorkspaceDir,
          Env: env,
          Tty: tty,
          OpenStdin: true,
          AttachStdin: true,
          ...(exposedPorts ? { ExposedPorts: exposedPorts } : {}),
          ...(app.name === aliasOwner
            ? {
                NetworkingConfig: {
                  EndpointsConfig: {
                    [deps.childNetwork]: { Aliases: [`telo-run-${spec.sessionId}`] },
                  },
                },
              }
            : {}),
          HostConfig: sessionHostConfig(
            portBindings ? { PortBindings: portBindings } : undefined,
          ),
        }),
      );
      containers.set(app.name, container);

      // Docker's non-TTY attach returns a multiplexed stream carrying a
      // per-frame stream id, so under `io: "streams"` the split is real. Under
      // a TTY the daemon collapses it, and the tag says `tty` rather than
      // asserting a split that does not exist.
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
        logs: true,
      });
      streams.set(app.name, stream);
      if (tty) {
        stream.on("data", (chunk: Buffer) => {
          if (chunk.byteLength > 0) spec.onOutput(app.name, chunk, "tty");
        });
      } else {
        attachDemuxed(stream, (tag, chunk) => spec.onOutput(app.name, chunk, tag));
      }
      await container.start();

      void relayDebugStream({
        url: `http://${name}:${INSPECT_PORT + index}/events`,
        onFrame: (frame) => {
          applyPortsResolved(app.name, name, frame);
          spec.onDebug(app.name, frame);
        },
        signal: abort.signal,
      });

      const tcp = app.ports.filter((p) => p.protocol === "tcp").map((p) => p.port);
      if (tcp.length > 0) {
        void watchReachability({
          host: name,
          ports: tcp,
          onState: (port, state) => spec.onReachability(app.name, port, state),
          signal: abort.signal,
        });
      }

      void container.wait().then(
        (info) => {
          // A watch session's app container exiting on its own is never a normal
          // run ending — under `--watch` a finished run leaves the container up.
          // Reported through the contract, not by synthesizing a kernel frame:
          // the debug stream carries frames the WORKLOAD produced, and a backend
          // writing into it would put an event on the wire no kernel emitted.
          if (teardownInProgress || userStopped) return;
          spec.onRunEnded(app.name, {
            reason:
              info?.Error?.Message ??
              `application container exited (code ${info?.StatusCode ?? "unknown"})`,
          });
        },
        () => {
          /* wait rejects when the daemon already removed it */
        },
      );
    }
  }

  /**
   * A proxy in front of sessions resolves `telo-run-<sessionId>` — one name per
   * session, from before a session could run several applications. Giving that
   * name as a network ALIAS to the container that actually binds the ports keeps
   * the existing route working with no per-session configuration.
   *
   * With SEVERAL port-declaring apps the name is genuinely ambiguous: docker
   * round-robins a shared alias, so half the requests would reach the wrong
   * application. Nothing is aliased then, and every affected port is reported as
   * rejected — an app that binds a port and is silently unreachable is the one
   * outcome worth designing against.
   *
   * Recomputed per start, because `setApps` changes which app owns the name.
   */
  function resolveAliasOwner(): string | undefined {
    const owners = apps.filter((a) => a.ports.length > 0);
    if (owners.length === 1) return owners[0]!.name;
    if (deps.publicBaseUrl) {
      for (const app of owners) {
        spec.onEndpoints(app.name, {
          rejected: app.ports.map((p) => ({
            port: p.port,
            reason:
              "this runner fronts sessions with a proxy that resolves one name per session " +
              `(telo-run-<sessionId>), and ${owners.length} apps in this session declare ports`,
          })),
        });
      }
    }
    return undefined;
  }

  /**
   * Re-route an app whose declared port set changed on reload.
   *
   * The kernel re-resolves its `ports:` block on every load and says so on the
   * stream the runner already reads, so nothing here parses a manifest.
   *
   * What docker can honour depends on how sessions are fronted. Behind a proxy
   * nothing has to change: it reaches the container by NAME on any port, and
   * `PortBindings` are not used at all — so a newly declared port is reachable
   * the moment something binds it, and this only has to say so. With host
   * publishing there is no equivalent: `PortBindings` are fixed at container
   * creation, so the port is reported as unroutable rather than silently
   * unreachable, which is the one outcome worth designing against.
   */
  function applyPortsResolved(appName: string, containerName: string, frame: DebugFrame): void {
    const declared = portsResolvedFrom(frame);
    if (!declared) return;
    const app = apps.find((a) => a.name === appName);
    if (!app) return;

    const before = new Map(app.ports.map((p) => [portKey(p), p]));
    const after = new Map(declared.map((p) => [portKey(p), p]));
    const added = declared.filter((p) => !before.has(portKey(p)));
    const removed = app.ports.filter((p) => !after.has(portKey(p)));
    if (added.length === 0 && removed.length === 0) return;

    const taken = new Set(
      apps.filter((a) => a.name !== appName).flatMap((a) => a.ports.map(portKey)),
    );
    const conflicting = added.filter((p) => taken.has(portKey(p)));
    const routable = deps.publicBaseUrl ? added.filter((p) => !taken.has(portKey(p))) : [];
    const unpublishable = deps.publicBaseUrl
      ? []
      : added.filter((p) => !taken.has(portKey(p)));

    app.ports = [...app.ports.filter((p) => after.has(portKey(p))), ...routable];

    spec.onEndpoints(appName, {
      ...(routable.length > 0 ? { added: endpointsFor([{ ...app, ports: routable }]) } : {}),
      ...(removed.length > 0 ? { removed: endpointsFor([{ ...app, ports: removed }]) } : {}),
      ...(conflicting.length > 0 || unpublishable.length > 0
        ? {
            rejected: [
              ...conflicting.map((p) => ({
                port: p.port,
                reason: `another app in this session already declares ${p.protocol} port ${p.port}`,
              })),
              ...unpublishable.map((p) => ({
                port: p.port,
                reason:
                  "this runner publishes session ports to the host, and a container's port " +
                  "bindings are fixed at creation — restart the session to reach this port",
              })),
            ],
          }
        : {}),
    });

    const tcp = routable.filter((p) => p.protocol === "tcp").map((p) => p.port);
    if (tcp.length > 0) {
      void watchReachability({
        host: containerName,
        ports: tcp,
        onState: (port, state) => spec.onReachability(appName, port, state),
        signal: abort.signal,
      });
    }
  }

  /**
   * The agent gets its own network alias, `telo-run-<sessionId>-agent`, rather
   * than sharing the session's. That is what keeps it reachable behind the
   * proxy WITHOUT touching the app's routing: a shared alias is round-robined
   * by docker, so putting the agent on `telo-run-<sessionId>` would make every
   * app port a coin flip — the exact ambiguity a multi-app session already has
   * to refuse.
   *
   * It needs no proxy configuration either, because the session label is the
   * proxy's trailing capture: `<agentPort>-<sessionId>-agent.<domain>` resolves
   * to `telo-run-<sessionId>-agent:<agentPort>` under the rule already there.
   *
   * With no proxy the port is published to the host like an app's, and the
   * client fills the hostname from the base URL it reached the runner on.
   */
  async function startAgentContainer(agent: ResolvedRunnerApp): Promise<void> {
    const publishToHost = !deps.publicBaseUrl;
    const key = agent.port !== undefined ? `${agent.port}/tcp` : null;
    const container = await createAndStart(
      containerName("agent"),
      baseOpts({
        Image: agent.image,
        // No Cmd and no WorkingDir: the catalog image runs its own baked entry
        // point from its own directory. Nothing of the runner's is mounted over
        // it — the workspace arrives at `/workspace` alone, so an image is free
        // to install itself anywhere, including under `/srv`.
        Cmd: undefined,
        WorkingDir: undefined,
        Env: [
          ...Object.entries(agent.env).map(([k, v]) => `${k}=${v}`),
          `WORKSPACE_DIR=${appWorkspaceDir}`,
          "CLICOLOR_FORCE=1",
        ],
        HostConfig: sessionHostConfig(
          key && publishToHost
            ? { PortBindings: { [key]: [{ HostIp: "", HostPort: String(agent.port) }] } }
            : undefined,
        ),
        ...(key ? { ExposedPorts: { [key]: {} } } : {}),
        ...(key
          ? {
              NetworkingConfig: {
                EndpointsConfig: {
                  [deps.childNetwork]: { Aliases: [`telo-run-${spec.sessionId}-agent`] },
                },
              },
            }
          : {}),
      }),
    );
    containers.set("agent", container);
    await container.start();
  }

  /** Where this session's co-resident agent answers — the counterpart of
   *  `endpointsFor` for the one container that is session infrastructure rather
   *  than an application. */
  function agentStatusField(): { agent?: RunnerEndpoint } {
    const endpoint = agentEndpoint();
    return endpoint ? { agent: endpoint } : {};
  }

  function agentEndpoint(): RunnerEndpoint | undefined {
    const port = spec.agent?.port;
    if (port === undefined) return undefined;
    if (!deps.publicBaseUrl) return { host: "", port, protocol: "tcp" };
    const base = new URL(deps.publicBaseUrl);
    return {
      // `host` is a hostname (the port has its own field); the URL below is
      // where `base.host` belongs, since that one wants the port too.
      host: `${port}-${spec.sessionId}-agent.${base.hostname}`,
      port,
      protocol: "tcp",
      url: `${base.protocol}//${port}-${spec.sessionId}-agent.${base.host}`,
    };
  }

  async function removeContainer(key: string): Promise<void> {
    const container = containers.get(key);
    if (!container) return;
    containers.delete(key);
    streams.delete(key);
    await stopContainer(container).catch(() => {
      /* already gone */
    });
  }

  async function stopAll(): Promise<void> {
    clearTimeout(deadline);
    abort.abort();
    for (const key of [...containers.keys()]) await removeContainer(key);
  }

  function endpointsFor(forApps: BackendAppSpec[]): RunnerEndpoint[] {
    const base = deps.publicBaseUrl ? new URL(deps.publicBaseUrl) : null;
    return forApps.flatMap((app) =>
      app.ports.map((p) => {
        if (!base || p.protocol !== "tcp") {
          return { host: "", port: p.port, protocol: p.protocol };
        }
        return {
          host: `${spec.sessionId}.${base.hostname}`,
          port: p.port,
          protocol: p.protocol,
          url: `${base.protocol}//${p.port}-${spec.sessionId}.${base.host}`,
        };
      }),
    );
  }

  async function waitForWorkspace(ws: WorkspaceClient, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + WORKSPACE_READY_TIMEOUT_MS;
    let last = "no response";
    for (;;) {
      if (signal.aborted) throw new Error("session stopped while the workspace was coming up");
      try {
        await ws.tree();
        return;
      } catch (err) {
        last = message(err);
      }
      if (Date.now() > deadline) {
        throw new SessionStartError(
          "start_failed",
          "start",
          `workspace container did not become ready: ${last}`,
          last,
        );
      }
      await sleep(POLL_MS);
    }
  }
}

/** Docker's multiplexed (non-TTY) attach frames: an 8-byte header whose first
 *  byte is the stream id, then a 4-byte big-endian payload length. Exported for
 *  its own tests: a header split across two chunks, or two frames arriving in
 *  one, are the cases a demuxer gets wrong. */
export function attachDemuxed(
  stream: NodeJS.ReadWriteStream,
  onChunk: (tag: ByteStreamTag, chunk: Buffer) => void,
): void {
  let pending: Buffer = Buffer.alloc(0);
  stream.on("data", (chunk: Buffer) => {
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 8) return;
      const length = pending.readUInt32BE(4);
      if (pending.length < 8 + length) return;
      const tag: ByteStreamTag = pending[0] === 2 ? "stderr" : "stdout";
      onChunk(tag, Buffer.from(pending.subarray(8, 8 + length)));
      pending = Buffer.from(pending.subarray(8 + length));
    }
  });
}

function portConfig(
  app: BackendAppSpec,
  publishToHost: boolean,
): {
  exposedPorts?: Record<string, Record<string, never>>;
  portBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>>;
} {
  if (app.ports.length === 0) return {};
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const { port, protocol } of app.ports) {
    const key = `${port}/${protocol}`;
    exposedPorts[key] = {};
    if (publishToHost) portBindings[key] = [{ HostIp: "", HostPort: String(port) }];
  }
  return publishToHost ? { exposedPorts, portBindings } : { exposedPorts };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

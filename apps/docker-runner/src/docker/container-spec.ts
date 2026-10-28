import {
  WORKSPACE_APP_FILENAME,
  agentImage,
  type BackendAppSpec,
  type ReservedPort,
  type RunnerAgent,
} from "@telorun/runner-core";

import type { CreateContainerOpts, PortBindings, VolumeMount } from "./docker-api.js";

/** Every container of a session's workload carries its id here; adoption, the
 *  orphan sweep and `destroy` find them by it, never by name. */
export const SESSION_ID_LABEL = "telo.run/session-id";
/** `workspace`, `agent`, or `app`. */
export const ROLE_LABEL = "telo.run/role";
export const APP_LABEL = "telo.run/app";
/** The build of the session supervisor an app container mounts, so the sweep
 *  keeps every build a container still runs. */
export const SUPERVISOR_BUILD_LABEL = "telo.run/supervisor-build";

/** Where the runner's own `workspace` container sees the whole bundle volume:
 *  its manifest and its cache sit BESIDE the workspace it serves. */
const SRV = "/srv";
/** Where every other container sees the session's `workspace/` alone — the path
 *  kubernetes uses, so a manifest is `/workspace/telo.yaml` on both. */
export const WORKSPACE_MOUNT = "/workspace";
/** Where the agent sees its own state (`agent/` of the session's directory),
 *  outside the workspace tree, so nothing syncs it. */
export const AGENT_STATE_DIR = "/var/lib/telo-agent-state";
/** Where the runner's image carries the session supervisor, and where every app
 *  container mounts the copy the runner wrote to the bundle volume. */
export const SUPERVISOR_DIR = "/opt/telo-runner";
export const SUPERVISOR_PATH = `${SUPERVISOR_DIR}/supervisor`;

export const SUPERVISOR_LISTEN_ENV = "TELO_SUPERVISOR_LISTEN";
export const SUPERVISOR_TOKEN_ENV = "TELO_SUPERVISOR_TOKEN";

export const WORKSPACE_PORT = 8099;
const INSPECT_PORT_BASE = 9230;
const SUPERVISOR_PORT_BASE = 9330;

/** By position, as on kubernetes, so an app's machinery ports are the same
 *  whichever backend runs it. */
export function inspectPortFor(index: number): number {
  return INSPECT_PORT_BASE + index;
}

export function supervisorPortFor(index: number): number {
  return SUPERVISOR_PORT_BASE + index;
}

export function reservedPortsFor(apps: BackendAppSpec[]): ReservedPort[] {
  return apps.flatMap((app, index) => [
    { app: app.name, port: supervisorPortFor(index), protocol: "tcp" as const, purpose: "the session supervisor" },
    { app: app.name, port: inspectPortFor(index), protocol: "tcp" as const, purpose: "the kernel debug stream" },
  ]);
}

/** A session's containers are named `telo-run-<sessionId>-<role>`; the proxy
 *  in front of sessions resolves `telo-run-<sessionId>` as an alias. */
export function containerName(sessionId: string, role: string): string {
  return `telo-run-${sessionId}-${role}`;
}

export function appRole(app: string): string {
  return `app-${app}`;
}

/** The session's directory on the bundle volume, relative to its root. */
export function sessionSubpath(sessionId: string, entry: "workspace" | "agent"): string {
  return `${sessionId}/${entry}`;
}

export interface SessionContainerArgs {
  sessionId: string;
  /** Daemon-visible name of the bundle volume. */
  bundleVolume: string;
  childNetwork: string;
  /** Set: a proxy fronts sessions by name and nothing is published on the
   *  host. Unset: declared ports are published to the same host port. */
  publicBaseUrl?: string;
}

function labels(sessionId: string, role: string, extra: Record<string, string> = {}): Record<string, string> {
  return { [SESSION_ID_LABEL]: sessionId, [ROLE_LABEL]: role, ...extra };
}

function idle(): Pick<CreateContainerOpts, "Tty" | "OpenStdin" | "AttachStdin" | "AttachStdout" | "AttachStderr"> {
  return { Tty: false, OpenStdin: false, AttachStdin: false, AttachStdout: false, AttachStderr: false };
}

function workspaceMount(args: SessionContainerArgs): VolumeMount {
  return {
    Type: "volume",
    Source: args.bundleVolume,
    Target: WORKSPACE_MOUNT,
    VolumeOptions: { Subpath: sessionSubpath(args.sessionId, "workspace") },
  };
}

function aliased(args: SessionContainerArgs, alias: string): Pick<CreateContainerOpts, "NetworkingConfig"> {
  return { NetworkingConfig: { EndpointsConfig: { [args.childNetwork]: { Aliases: [alias] } } } };
}

/**
 * The workspace surface: the runner's own manifest on the operator's kernel
 * image. The only container binding the volume whole, since its manifest and
 * cache sit beside the workspace; no app or agent container does.
 */
export function workspaceContainer(args: SessionContainerArgs, image: string): CreateContainerOpts {
  const root = `${SRV}/${args.sessionId}`;
  return {
    name: containerName(args.sessionId, "workspace"),
    Image: image,
    Cmd: ["telo", "run", `${root}/workspace-app/${WORKSPACE_APP_FILENAME}`],
    WorkingDir: `${root}/workspace`,
    Env: [`PORT=${WORKSPACE_PORT}`, `WORKSPACE_DIR=${root}/workspace`, `TELO_CACHE_DIR=${root}/cache/workspace`],
    Labels: labels(args.sessionId, "workspace"),
    ...idle(),
    HostConfig: { Binds: [`${args.bundleVolume}:${SRV}`], AutoRemove: false, NetworkMode: args.childNetwork },
  };
}

export interface AppContainerArgs {
  app: BackendAppSpec;
  index: number;
  image: string;
  /** This container's supervisor token. Its create options — read back by
   *  container inspect — are its durable home. */
  token: string;
  /** Where the supervisor this container mounts lives, relative to the volume. */
  supervisor: { build: string; subpath: string };
  /** Whether it takes the session's alias, `telo-run-<sessionId>`. */
  ownsSessionAlias: boolean;
}

/**
 * An idle slot: its main process is the session supervisor, waiting for a Run.
 * No TTY and no stdin — a run gets its own pty or pipes from the supervisor —
 * no session env, no shell. `Entrypoint` replaces the image's own, so the
 * supervisor is PID 1 and reaps what a run leaves.
 */
export function appContainer(args: SessionContainerArgs, a: AppContainerArgs): CreateContainerOpts {
  const role = appRole(a.app.name);
  const exposed: Record<string, Record<string, never>> = {};
  const bindings: PortBindings = {};
  for (const { port, protocol } of a.app.ports) {
    exposed[`${port}/${protocol}`] = {};
    if (!args.publicBaseUrl) bindings[`${port}/${protocol}`] = [{ HostIp: "", HostPort: String(port) }];
  }
  return {
    name: containerName(args.sessionId, role),
    Image: a.image,
    Entrypoint: [SUPERVISOR_PATH],
    WorkingDir: WORKSPACE_MOUNT,
    Env: [`${SUPERVISOR_LISTEN_ENV}=0.0.0.0:${supervisorPortFor(a.index)}`, `${SUPERVISOR_TOKEN_ENV}=${a.token}`],
    Labels: labels(args.sessionId, "app", { [APP_LABEL]: a.app.name, [SUPERVISOR_BUILD_LABEL]: a.supervisor.build }),
    ...idle(),
    ...(a.app.ports.length > 0 ? { ExposedPorts: exposed } : {}),
    ...(a.ownsSessionAlias ? aliased(args, `telo-run-${args.sessionId}`) : {}),
    HostConfig: {
      Binds: [],
      AutoRemove: false,
      NetworkMode: args.childNetwork,
      ...(Object.keys(bindings).length > 0 ? { PortBindings: bindings } : {}),
      Mounts: [
        workspaceMount(args),
        {
          Type: "volume",
          Source: args.bundleVolume,
          Target: SUPERVISOR_DIR,
          ReadOnly: true,
          VolumeOptions: { Subpath: a.supervisor.subpath },
        },
      ],
    },
  };
}

/** Where a host-path module is mounted in the agent container, read-only. */
export const AGENT_MODULE_MOUNT = "/opt/agent-module";

/**
 * The co-resident agent: the only container receiving the operator env. Its
 * image is its own, or the kernel image running `telo run` on its module — an
 * `oci://` ref fetched at start, or a host path bind-mounted read-only.
 * `TELO_HOST_STATE_DIR` points its `Telo.DurableDirectory` needs at the
 * session's `agent/`. Its own alias, `telo-run-<sessionId>-agent`, keeps the
 * session's alias unambiguous.
 */
export function agentContainer(
  args: SessionContainerArgs,
  agent: RunnerAgent,
  kernelImage: string,
): CreateContainerOpts {
  const key = `${agent.port}/tcp`;
  const module = agent.source.kind === "module" ? agent.source.ref : undefined;
  const hostPath = module !== undefined && !module.startsWith("oci://");
  return {
    name: containerName(args.sessionId, "agent"),
    Image: agentImage(agent, kernelImage),
    ...(module !== undefined
      ? {
          Cmd: ["telo", "run", "--no-input", hostPath ? AGENT_MODULE_MOUNT : module],
          WorkingDir: AGENT_STATE_DIR,
        }
      : {}),
    Env: [
      ...Object.entries(agent.env).map(([k, v]) => `${k}=${v}`),
      `WORKSPACE_DIR=${WORKSPACE_MOUNT}`,
      `TELO_HOST_STATE_DIR=${AGENT_STATE_DIR}`,
      ...(module !== undefined ? [`TELO_CACHE_DIR=${AGENT_STATE_DIR}/telo-cache`] : []),
      "CLICOLOR_FORCE=1",
    ],
    Labels: labels(args.sessionId, "agent"),
    ...idle(),
    ExposedPorts: { [key]: {} },
    ...aliased(args, `telo-run-${args.sessionId}-agent`),
    HostConfig: {
      Binds: hostPath ? [`${module}:${AGENT_MODULE_MOUNT}:ro`] : [],
      AutoRemove: false,
      NetworkMode: args.childNetwork,
      ...(!args.publicBaseUrl ? { PortBindings: { [key]: [{ HostIp: "", HostPort: String(agent.port) }] } } : {}),
      Mounts: [
        workspaceMount(args),
        {
          Type: "volume",
          Source: args.bundleVolume,
          Target: AGENT_STATE_DIR,
          VolumeOptions: { Subpath: sessionSubpath(args.sessionId, "agent") },
        },
      ],
    },
  };
}

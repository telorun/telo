import type { V1Container, V1Pod, V1Volume, V1VolumeMount } from "@kubernetes/client-node";

import type { PullPolicy, ReservedPort, ResolvedRunnerApp } from "@telorun/runner-core";
import { optionalContainerConfig } from "@telorun/runner-core/container";
import type { SessionConfig } from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../config.js";
import type { ResolvedLimits } from "../limits.js";

/** The label every session pod and session volume carries, valued with its id. */
export const SESSION_ID_LABEL = "telo.run/session-id";
export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";

/** Where every container sees the session's workspace (`workspace/` of the
 *  session volume). */
const WORKSPACE_DIR = "/workspace";
/** Where the agent sees its own state (`agent/` of the session volume) —
 *  outside the workspace tree, so nothing syncs it. */
export const AGENT_STATE_DIR = "/var/lib/telo-agent-state";
/** Where the runner's image carries the session supervisor, and where every app
 *  container mounts the copy the init container made. */
export const SUPERVISOR_DIR = "/opt/telo-runner";
export const SUPERVISOR_PATH = `${SUPERVISOR_DIR}/supervisor`;
/** Where the init container sees the copy's volume and the session volume. */
const SUPERVISOR_OUT_DIR = "/telo-runner-out";
const SESSION_VOLUME_ROOT = "/telo-session";

/**
 * Cache root for the WORKSPACE container only. The app containers deliberately
 * have none: their cache is anchored by the `telo-workspace.yaml` marker at the
 * workspace root, which puts one `.telo` on the session volume for every app in
 * the session. `TELO_CACHE_DIR` outranks the marker, so setting it per app is
 * exactly what would undo that. The workspace container needs an explicit root
 * because its manifest lives OUTSIDE the workspace.
 */
const CACHE_ROOT = "/telo-cache";
/** Where the workspace application's own manifest is mounted, read-only. It is
 *  outside `/workspace` on purpose — the user's tree is theirs. */
const WORKSPACE_APP_DIR = "/opt/telo-workspace";
const WORK_DIR = "/work";
/** Writable HOME / npm scratch under a read-only rootfs. */
const HOME_DIR = "/home/telo";
const TMP_MOUNT = "/tmp";

/** Port the workspace container serves its HTTP surface on, inside the pod. */
export const WORKSPACE_PORT = 8099;

/** The most apps one session runs. They all live in the pod's one `apps`
 *  container, which holds this many supervisor slots (and one more for the
 *  runner's own tooling), so the pod never changes shape with the app set. */
export const APP_SLOTS = 8;
/** The slot after the app slots: the runner's own tasks (fetching a telo
 *  release), never an application's. */
export const TOOLING_SLOT = APP_SLOTS;

/** The pod is one network namespace, so every slot's supervisor and every app
 *  slot's inspect endpoint take a port of their own, by slot. */
const INSPECT_PORT_BASE = 9230;
const SUPERVISOR_PORT_BASE = 9330;

export function inspectPortFor(slot: number): number {
  return INSPECT_PORT_BASE + slot;
}

export function supervisorPortFor(slot: number): number {
  return SUPERVISOR_PORT_BASE + slot;
}

/** The ports the pod binds for its machinery, whatever the app set; no app may
 *  declare one, since every container of the pod shares one network namespace. */
export function reservedPortsFor(): ReservedPort[] {
  const slots = Array.from({ length: APP_SLOTS + 1 }, (_, slot) => slot);
  return [
    ...slots.map((slot) => ({
      port: supervisorPortFor(slot),
      protocol: "tcp" as const,
      purpose: "the session supervisor",
    })),
    ...slots.slice(0, APP_SLOTS).map((slot) => ({
      port: inspectPortFor(slot),
      protocol: "tcp" as const,
      purpose: "the kernel debug stream",
    })),
  ];
}

/** The one container every application runs in. */
export const APPS_CONTAINER = "apps";

/** The pod annotation recording which slot each app holds, so an adopting runner
 *  knows where a live run is. */
export const APP_SLOTS_ANNOTATION = "telo.run/app-slots";

/** Where the session volume's `telo/` — the telo releases an app version asked
 *  for — is mounted in the apps container. */
export const RELEASES_DIR = "/var/lib/telo-releases";

export const SUPERVISOR_LISTEN_ENV = "TELO_SUPERVISOR_LISTEN";
export const SUPERVISOR_TOKEN_ENV = "TELO_SUPERVISOR_TOKEN";

export interface BuildSessionPodArgs {
  config: K8sRunnerConfig;
  sessionId: string;
  podName: string;
  /** The slot each app holds in the apps container. */
  appSlots: Record<string, number>;
  /** The token every slot's supervisor accepts. The pod spec is where an
   *  adopting runner reads it back. */
  supervisorToken: string;
  /** The resolved catalog entry of the co-resident agent, its `tokenEnv`
   *  already carrying this creation's token. Its env is the operator's. */
  agent?: ResolvedRunnerApp;
  /** The session's opaque config: the apps container's `image` / `pullPolicy`. */
  sessionConfig: SessionConfig;
  /** The session volume's claim. */
  claimName: string;
  /** Name of the ConfigMap holding the workspace application's manifest. */
  workspaceAppConfigMap: string;
  /** Host values the app containers' runs inherit (`TELO_HOST_PUBLIC_URL_*`).
   *  The runner's, never the session's. */
  hostEnv: Record<string, string>;
  limits: { app: ResolvedLimits; agent: ResolvedLimits };
}

/**
 * The session pod: a `workspace` container serving the editor's file routes,
 * one `apps` container running the session supervisor in a slot per
 * application, and an optional co-resident `agent`, all over the session's own
 * volume. Nothing runs an application until the runner sends a Run.
 *
 * Load-bearing properties:
 *
 *  - **No session env anywhere.** A run's env reaches the supervisor with the
 *    Run and lives only in the process; an app container carries its
 *    supervisor's listen address and token, which the supervisor removes from
 *    its environment before anything runs, and the runner's host values.
 *  - **The env split IS the credential boundary.** The operator env goes on
 *    `agent` alone; `workspace` gets neither.
 *  - **A shared GID.** Every container writes `/workspace`, so the pod needs an
 *    `fsGroup` they all share.
 *  - **The volume is not owned by the pod**, so deleting the pod (suspend, an
 *    agent change) keeps the files, the module cache and the agent's state.
 */
export function buildSessionPod(args: BuildSessionPodArgs): V1Pod {
  const { config } = args;
  const containers: V1Container[] = [workspaceContainer(args), appsContainer(args)];
  if (args.agent) containers.push(agentContainer(args, args.agent));

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: args.podName,
      namespace: config.sessionNamespace,
      labels: {
        [MANAGED_BY_LABEL]: config.managedByLabel,
        [SESSION_ID_LABEL]: args.sessionId,
      },
      annotations: { [APP_SLOTS_ANNOTATION]: JSON.stringify(args.appSlots) },
    },
    spec: {
      restartPolicy: "Never",
      // A backstop for a pod no runner process looks after any more; the
      // running limit core enforces suspends the session well before it.
      activeDeadlineSeconds: config.sessions.maxRunningSeconds,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...(config.imagePullSecret ? { imagePullSecrets: [{ name: config.imagePullSecret }] } : {}),
      ...(config.runtimeClass ? { runtimeClassName: config.runtimeClass } : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      initContainers: [supervisorInitContainer(args)],
      containers,
      volumes: sessionVolumes(args),
    },
  };
}

function sessionVolumes(args: BuildSessionPodArgs): V1Volume[] {
  return [
    { name: "session", persistentVolumeClaim: { claimName: args.claimName } },
    { name: "supervisor", emptyDir: {} },
    { name: "telo-cache", emptyDir: {} },
    { name: "work", emptyDir: {} },
    { name: "home", emptyDir: {} },
    { name: "tmp", emptyDir: {} },
    { name: "workspace-app", configMap: { name: args.workspaceAppConfigMap } },
  ];
}

/** Per-container scratch carved out of one volume by `subPath`. */
function scratchMounts(owner: string): V1VolumeMount[] {
  return [
    { name: "work", mountPath: WORK_DIR, subPath: owner },
    { name: "home", mountPath: HOME_DIR, subPath: owner },
    { name: "tmp", mountPath: TMP_MOUNT, subPath: owner },
  ];
}

const workspaceMount: V1VolumeMount = { name: "session", mountPath: WORKSPACE_DIR, subPath: "workspace" };

function resourcesOf(limits: ResolvedLimits): Record<string, unknown> {
  return {
    limits: { cpu: limits.cpu, memory: limits.memory, "ephemeral-storage": limits.ephemeralStorage },
    requests: { cpu: limits.cpu, memory: limits.memory },
  };
}

function hardenedContainerSecurity(): Record<string, unknown> {
  return {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    capabilities: { drop: ["ALL"] },
  };
}

/**
 * Copies the session supervisor out of the runner's own image, and makes the
 * session volume's two directories as the pod's user — a `subPath` the kubelet
 * creates itself is root's, which no container here could write.
 */
function supervisorInitContainer(args: BuildSessionPodArgs): V1Container {
  return {
    name: "supervisor",
    image: args.config.supervisorImage,
    imagePullPolicy: "IfNotPresent",
    command: [
      "sh",
      "-c",
      `mkdir -p ${SESSION_VOLUME_ROOT}/workspace ${SESSION_VOLUME_ROOT}/agent ${SESSION_VOLUME_ROOT}/telo && ` +
        `cp ${SUPERVISOR_PATH} ${SUPERVISOR_OUT_DIR}/supervisor`,
    ],
    resources: resourcesOf(args.limits.app),
    volumeMounts: [
      { name: "supervisor", mountPath: SUPERVISOR_OUT_DIR },
      { name: "session", mountPath: SESSION_VOLUME_ROOT },
    ],
    securityContext: hardenedContainerSecurity(),
  };
}

/**
 * The workspace surface is RUNNER infrastructure: it runs the operator's kernel
 * image over a manifest mounted from a ConfigMap, verified against the kernel the
 * runner ships with.
 */
function workspaceContainer(args: BuildSessionPodArgs): V1Container {
  return {
    name: "workspace",
    image: args.config.defaultImage,
    imagePullPolicy: pullPolicyToK8s(args.config.teloImages.pullPolicy),
    workingDir: WORK_DIR,
    command: ["telo", "run", `${WORKSPACE_APP_DIR}/telo.yaml`],
    env: [
      { name: "PORT", value: String(WORKSPACE_PORT) },
      { name: "WORKSPACE_DIR", value: WORKSPACE_DIR },
      { name: "TELO_CACHE_DIR", value: `${CACHE_ROOT}/workspace` },
      { name: "HOME", value: HOME_DIR },
      { name: "npm_config_cache", value: `${HOME_DIR}/.npm` },
    ],
    ports: [{ containerPort: WORKSPACE_PORT, protocol: "TCP" }],
    resources: resourcesOf(args.limits.app),
    volumeMounts: [
      workspaceMount,
      { name: "telo-cache", mountPath: CACHE_ROOT },
      { name: "workspace-app", mountPath: WORKSPACE_APP_DIR, readOnly: true },
      ...scratchMounts("workspace"),
    ],
    securityContext: hardenedContainerSecurity(),
  };
}

/** The one container of every application: `APP_SLOTS` idle supervisors plus the
 *  tooling slot. No TTY and no stdin — a run gets its own pty or pipes from its
 *  slot's supervisor — and its stdout/stderr carry the supervisors' own log
 *  only. Adding, removing or re-versioning an app changes nothing here, which is
 *  what keeps the pod (and the workspace and agent in it) running. */
function appsContainer(args: BuildSessionPodArgs): V1Container {
  const image = appsImage(args.config, args.sessionConfig);
  return {
    name: APPS_CONTAINER,
    image: image.image,
    imagePullPolicy: pullPolicyToK8s(image.pullPolicy),
    workingDir: WORK_DIR,
    command: [SUPERVISOR_PATH, "--slots", String(APP_SLOTS + 1)],
    env: [
      { name: SUPERVISOR_LISTEN_ENV, value: `0.0.0.0:${supervisorPortFor(0)}` },
      { name: SUPERVISOR_TOKEN_ENV, value: args.supervisorToken },
      ...Object.entries(args.hostEnv).map(([name, value]) => ({ name, value })),
      { name: "HOME", value: HOME_DIR },
      { name: "npm_config_cache", value: `${HOME_DIR}/.npm` },
    ],
    ports: [{ containerPort: supervisorPortFor(0), protocol: "TCP" }],
    resources: resourcesOf(args.limits.app),
    volumeMounts: [
      workspaceMount,
      { name: "session", mountPath: RELEASES_DIR, subPath: "telo" },
      { name: "supervisor", mountPath: SUPERVISOR_DIR, readOnly: true },
      ...scratchMounts("apps"),
    ],
    securityContext: hardenedContainerSecurity(),
  };
}

/**
 * At most one agent per session: its unit is the workspace. The ONLY container
 * that receives the operator env, and the only one whose write-path hardening is
 * relaxed (an operator-curated image). `TELO_HOST_STATE_DIR` points its
 * `Telo.DurableDirectory` needs at the session volume's `agent/`.
 */
function agentContainer(args: BuildSessionPodArgs, agent: ResolvedRunnerApp): V1Container {
  return {
    name: "agent",
    image: agent.image,
    imagePullPolicy: pullPolicyToK8s(agent.pullPolicy),
    env: [
      ...Object.entries(agent.env).map(([name, value]) => ({ name, value })),
      { name: "WORKSPACE_DIR", value: WORKSPACE_DIR },
      { name: "TELO_HOST_STATE_DIR", value: AGENT_STATE_DIR },
      { name: "CLICOLOR_FORCE", value: "1" },
    ],
    ...(agent.port !== undefined ? { ports: [{ containerPort: agent.port, protocol: "TCP" }] } : {}),
    resources: resourcesOf(args.limits.agent),
    volumeMounts: [
      workspaceMount,
      { name: "session", mountPath: AGENT_STATE_DIR, subPath: "agent" },
      ...scratchMounts("agent"),
    ],
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    },
  };
}

/** The session's picked image (with the policy it sent) or the runner's default.
 *  An app naming a telo version does not change it: that telo is fetched into
 *  the container, never the image. */
function appsImage(
  config: K8sRunnerConfig,
  sessionConfig: SessionConfig,
): { image: string; pullPolicy: PullPolicy } {
  const picked = optionalContainerConfig(sessionConfig);
  return { image: picked.image ?? config.defaultImage, pullPolicy: picked.pullPolicy };
}

function pullPolicyToK8s(policy: PullPolicy): string {
  switch (policy) {
    case "always":
      return "Always";
    case "never":
      return "Never";
    default:
      return "IfNotPresent";
  }
}

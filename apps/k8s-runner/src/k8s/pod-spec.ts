import type { V1Container, V1Pod, V1Volume, V1VolumeMount } from "@kubernetes/client-node";

import type { K8sRunnerConfig } from "../config.js";
import type { ResolvedLimits } from "../limits.js";
import type {
  BackendAppSpec,
  PortMapping,
  PullPolicy,
  ResolvedRunnerApp,
} from "@telorun/runner-core";

export interface BuildPodArgs {
  config: K8sRunnerConfig;
  sessionId: string;
  podName: string;
  entryRelativePath: string;
  env: Record<string, string>;
  ports: PortMapping[];
  limits: ResolvedLimits;
  /** The kernel image to run (`telorun/node`) — the session's picked base image,
   *  or the runner's default. Nothing is baked per app: the body arrives over the
   *  initContainer and the kernel resolves its module closure at boot. */
  image: string;
  pullPolicy: PullPolicy;
  /** Tokenized, single-use URL the body-delivery initContainer fetches the
   *  session bundle tarball from (`BundleStore.stageSessionBundle`). */
  bundleUrl: string;
  /** When true, run the workload with `--inspect` so the runner can relay its
   *  kernel debug stream. Binds `0.0.0.0:<INSPECT_PORT>` (reachable only by the
   *  runner over the cluster pod network — never exposed via Service/Ingress). */
  inspect: boolean;
}

/** Port the workload's `--inspect` server binds inside the session container.
 *  Reached by the runner over the cluster pod network (`http://<podIP>:<port>`);
 *  never declared as a Service port — only the runner relays the stream out. */
export const INSPECT_PORT = 9230;

const APP_DIR = "/app";
const WORK_DIR = "/work";
/** The kernel's module cache for this session. A writable emptyDir: the closure
 *  is resolved at boot and lives as long as the pod, so a re-run of the same app
 *  is a fresh download — the price of having no prebuilt image. */
const DEPS_DIR = "/telo-cache";
/** Writable HOME / npm scratch under a read-only rootfs. */
const HOME_DIR = "/home/telo";
const TMP_MOUNT = "/tmp";

/**
 * Builds the session Pod. Hardening that needs no RuntimeClass is always on
 * (non-root, read-only rootfs, drop-all caps, no service-account token,
 * seccomp RuntimeDefault); a sandbox RuntimeClass is layered on when configured.
 *
 * The body-delivery initContainer fetches the session bundle into the writable
 * `/app` emptyDir; the session container runs `telo run /app/<entry>` on the
 * plain kernel image and resolves its module closure into `/telo-cache`.
 * `readOnlyRootFilesystem` stays on — every write lands on a mounted emptyDir.
 */
export function buildSessionPod(args: BuildPodArgs): V1Pod {
  const { config, limits } = args;

  const resources = {
    limits: {
      cpu: limits.cpu,
      memory: limits.memory,
      "ephemeral-storage": limits.ephemeralStorage,
    },
    requests: {
      cpu: limits.cpu,
      memory: limits.memory,
    },
  };

  const envVars = Object.entries(args.env).map(([name, value]) => ({ name, value }));
  // Resolve deps into the session's own `/telo-cache` emptyDir; keep HOME/npm
  // scratch on a separate one under the read-only root filesystem.
  envVars.push({ name: "TELO_CACHE_DIR", value: DEPS_DIR });
  envVars.push({ name: "HOME", value: HOME_DIR });
  envVars.push({ name: "npm_config_cache", value: `${HOME_DIR}/.npm` });
  envVars.push({ name: "FORCE_COLOR", value: "1" });

  const pod: V1Pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: args.podName,
      namespace: config.sessionNamespace,
      labels: {
        "app.kubernetes.io/managed-by": config.managedByLabel,
        "telo.run/session-id": args.sessionId,
      },
    },
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: limits.ttlSeconds,
      automountServiceAccountToken: false,
      // Pull the kernel image from a private registry. The Secret must exist in
      // the session namespace (pull secrets are namespace-scoped).
      ...(config.imagePullSecret ? { imagePullSecrets: [{ name: config.imagePullSecret }] } : {}),
      ...(config.runtimeClass ? { runtimeClassName: config.runtimeClass } : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      initContainers: [
        {
          // Deliver the session body into the writable /app emptyDir.
          name: "body-fetch",
          image: config.initImage,
          command: ["sh", "-c"],
          args: [
            `set -e; wget -qO /tmp/body.tgz "${args.bundleUrl}"; tar xzf /tmp/body.tgz -C ${APP_DIR}`,
          ],
          volumeMounts: [
            { name: "app", mountPath: APP_DIR },
            { name: "tmp", mountPath: TMP_MOUNT },
          ],
          securityContext: hardenedContainerSecurity(),
        },
      ],
      containers: [
        {
          name: "session",
          image: args.image,
          imagePullPolicy: pullPolicyToK8s(args.pullPolicy),
          // Run the delivered body by absolute path. WORK_DIR is a writable
          // emptyDir cwd so the workload's relative paths resolve under
          // readOnlyRootFilesystem.
          workingDir: WORK_DIR,
          // 0.0.0.0 (not the CLI's loopback default) lets the runner reach the
          // debug server across the pod network; the port is never published.
          command: [
            "telo",
            "run",
            `${APP_DIR}/${args.entryRelativePath}`,
            ...(args.inspect ? ["--inspect", `0.0.0.0:${INSPECT_PORT}`, "--no-open"] : []),
          ],
          env: envVars,
          stdin: true,
          stdinOnce: false,
          tty: true,
          ...(args.ports.length > 0
            ? { ports: args.ports.map((p) => ({ containerPort: p.port, protocol: p.protocol.toUpperCase() })) }
            : {}),
          resources,
          volumeMounts: [
            { name: "app", mountPath: APP_DIR },
            { name: "telo-cache", mountPath: DEPS_DIR },
            { name: "work", mountPath: WORK_DIR },
            { name: "home", mountPath: HOME_DIR },
            { name: "tmp", mountPath: TMP_MOUNT },
          ],
          securityContext: hardenedContainerSecurity(),
        },
      ],
      volumes: [
        { name: "app", emptyDir: {} },
        { name: "telo-cache", emptyDir: {} },
        { name: "work", emptyDir: {} },
        { name: "home", emptyDir: {} },
        { name: "tmp", emptyDir: {} },
      ],
    },
  };

  return pod;
}

function hardenedContainerSecurity(): Record<string, unknown> {
  return {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    capabilities: { drop: ["ALL"] },
  };
}

export interface BuildAppPodArgs {
  config: K8sRunnerConfig;
  sessionId: string;
  podName: string;
  env: Record<string, string>;
  ports: PortMapping[];
  limits: ResolvedLimits;
  /** Self-contained image from the operator's app catalog — app + controllers
   *  baked in; the pod runs the image's own entrypoint. */
  image: string;
  pullPolicy: PullPolicy;
}

/**
 * Builds a Pod for an operator-predefined app session (`RUNNER_APPS`). Unlike
 * session pods the image is operator-curated, not anonymous code, so the
 * write-path hardening is relaxed: the image's own filesystem layout and user
 * apply (a self-contained app may write inside its own image directories),
 * with no rootfs read-only forcing and no bundle initContainer. Everything
 * else stays on: seccomp RuntimeDefault, all capabilities dropped, no
 * privilege escalation, no ServiceAccount token, the sandbox RuntimeClass when
 * configured, and the app resource ceilings.
 */
export function buildAppPod(args: BuildAppPodArgs): V1Pod {
  const { config, limits } = args;

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: args.podName,
      namespace: config.sessionNamespace,
      labels: {
        "app.kubernetes.io/managed-by": config.managedByLabel,
        "telo.run/session-id": args.sessionId,
      },
    },
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: limits.ttlSeconds,
      automountServiceAccountToken: false,
      ...(config.imagePullSecret ? { imagePullSecrets: [{ name: config.imagePullSecret }] } : {}),
      ...(config.runtimeClass ? { runtimeClassName: config.runtimeClass } : {}),
      securityContext: {
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "session",
          image: args.image,
          imagePullPolicy: pullPolicyToK8s(args.pullPolicy),
          env: [
            ...Object.entries(args.env).map(([name, value]) => ({ name, value })),
            { name: "FORCE_COLOR", value: "1" },
          ],
          stdin: true,
          stdinOnce: false,
          tty: true,
          ...(args.ports.length > 0
            ? { ports: args.ports.map((p) => ({ containerPort: p.port, protocol: p.protocol.toUpperCase() })) }
            : {}),
          resources: {
            limits: {
              cpu: limits.cpu,
              memory: limits.memory,
              "ephemeral-storage": limits.ephemeralStorage,
            },
            requests: {
              cpu: limits.cpu,
              memory: limits.memory,
            },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
  };
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

// ---------------------------------------------------------------------------
// Watch sessions — one pod, one workspace, one container per running application
// ---------------------------------------------------------------------------

/** Where every container sees the shared workspace volume. */
const WORKSPACE_DIR = "/workspace";
/**
 * Cache root for the WORKSPACE container only.
 *
 * The application containers deliberately have none: their cache is anchored by
 * the `telo-workspace.yaml` marker seeded at the workspace root, which puts one
 * cache under `/workspace/.telo` for every app in the session — so two apps
 * importing the same module resolve it once between them. `TELO_CACHE_DIR`
 * outranks the marker, so setting it per app is exactly what would undo that.
 *
 * The workspace container needs an explicit root because its manifest lives
 * OUTSIDE the workspace: the kernel walks up from the entry file, which for it
 * is `/opt/telo-workspace`, so it would never see the marker.
 */
const CACHE_ROOT = "/telo-cache";
/** Where the workspace application's own manifest is mounted, read-only. It is
 *  outside `/workspace` on purpose — the user's tree is theirs, and an
 *  infrastructure manifest sitting in it would be diffed, listed and editable. */
const WORKSPACE_APP_DIR = "/opt/telo-workspace";
/** Port the workspace container serves its HTTP surface on, inside the pod. */
export const WORKSPACE_PORT = 8099;

/** Each app's kernel debug endpoint. Containers in one pod share a network
 *  namespace, so the port has to differ per app or the second bind fails. */
export function inspectPortFor(index: number): number {
  return INSPECT_PORT + index;
}

export interface BuildWatchPodArgs {
  config: K8sRunnerConfig;
  sessionId: string;
  podName: string;
  /** Session-declared env. Goes on every `app-<name>` container and NOWHERE
   *  else — `workspace` serves files and holds no secrets, and the agent gets
   *  the operator's env instead. */
  env: Record<string, string>;
  apps: BackendAppSpec[];
  /** Resolved catalog entry for the co-resident agent, when one was requested.
   *  Its env is the operator's, LLM key included. */
  agent?: ResolvedRunnerApp;
  limits: ResolvedLimits;
  /** Base image every app container and the workspace container run — the plain
   *  kernel image (`telorun/node`). Each resolves its own module closure into
   *  the shared workspace volume, which lives as long as the pod. */
  image: string;
  pullPolicy: PullPolicy;
  /** Name of the ConfigMap holding the workspace application's manifest. */
  workspaceAppConfigMap: string;
}

/**
 * The co-resident watch pod.
 *
 * One pod, one workspace volume, and one container per running application. An
 * edit reaches the volume two ways and only two: the agent writes files directly
 * with its own filesystem tools, and everyone outside the pod goes through the
 * `workspace` container's HTTP surface. Both land on one volume that N watchers
 * observe — which is what replaces the tokenized body tarball, the per-session
 * bundle re-fetch and the separate agent session.
 *
 * Three properties are load-bearing and easy to lose:
 *
 *  - **A shared GID.** Every container reads and writes `/workspace`, so the pod
 *    needs an `fsGroup` they all share. Without it the agent writes files the app
 *    cannot read, which surfaces as a manifest that "does not exist" one reload
 *    after it was written.
 *  - **The env split IS the credential boundary.** It used to be structural (two
 *    pods) and is now a code invariant (containers in one pod): the operator env
 *    goes on `agent` alone, every `app-<name>` gets the session's declared env
 *    and nothing else, and `workspace` gets neither.
 *  - **`CLICOLOR_FORCE` is set per app, and only under `io: "tty"`.** Forcing
 *    colour in a mode whose whole purpose is "show me what production sees"
 *    defeats the mode. It is set here rather than baked into the image because
 *    the usual way to override an image default (an empty value in a pod spec)
 *    sets the variable EMPTY, which the precedence order reads as present and
 *    forcing — so a baked default would be undisableable by the normal means.
 */
export function buildWatchPod(args: BuildWatchPodArgs): V1Pod {
  const { config, limits } = args;

  const containers: V1Container[] = [
    workspaceContainer(args),
    ...args.apps.map((app, index) => appContainer(args, app, index)),
  ];
  if (args.agent) containers.push(agentContainer(args, args.agent));

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: args.podName,
      namespace: config.sessionNamespace,
      labels: {
        "app.kubernetes.io/managed-by": config.managedByLabel,
        "telo.run/session-id": args.sessionId,
        "telo.run/mode": "watch",
      },
    },
    spec: {
      restartPolicy: "Never",
      // One deadline covers every container, so it takes the longer (agent)
      // ceiling and lets idleness do the real work — an hour would kill a
      // conversation mid-turn.
      activeDeadlineSeconds: config.watch.maxTtlSeconds,
      automountServiceAccountToken: false,
      ...(config.imagePullSecret ? { imagePullSecrets: [{ name: config.imagePullSecret }] } : {}),
      ...(config.runtimeClass ? { runtimeClassName: config.runtimeClass } : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        // The shared GID. Every container writes /workspace.
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers,
      volumes: watchVolumes(args),
    },
  };
}

function watchVolumes(args: BuildWatchPodArgs): V1Volume[] {
  return [
    { name: "workspace", emptyDir: {} },
    // One cache volume, one subdirectory per app. Lives as long as the pod, so
    // a module closure is downloaded once per app per session and every later
    // reload resolves from local disk.
    { name: "telo-cache", emptyDir: {} },
    { name: "work", emptyDir: {} },
    { name: "home", emptyDir: {} },
    { name: "tmp", emptyDir: {} },
    {
      name: "workspace-app",
      configMap: { name: args.workspaceAppConfigMap },
    },
  ];
}

/** Per-container scratch carved out of one volume by `subPath`, so N apps do not
 *  mean 3N pod volumes. */
function scratchMounts(owner: string): V1VolumeMount[] {
  return [
    { name: "work", mountPath: WORK_DIR, subPath: owner },
    { name: "home", mountPath: HOME_DIR, subPath: owner },
    { name: "tmp", mountPath: TMP_MOUNT, subPath: owner },
  ];
}

function watchResources(limits: ResolvedLimits): Record<string, unknown> {
  return {
    limits: {
      cpu: limits.cpu,
      memory: limits.memory,
      "ephemeral-storage": limits.ephemeralStorage,
    },
    requests: { cpu: limits.cpu, memory: limits.memory },
  };
}

/**
 * The workspace surface is RUNNER infrastructure, not agent functionality — it
 * is part of the `/v1` session contract, so the runner owns it and the agent is
 * one more writer on the volume beside the app containers. Hanging it off the
 * catalog image would invert the dependency (the session contract resting on an
 * application the operator configures) and would need a second implementation
 * for the agentless case.
 *
 * It runs the plain kernel image over a manifest mounted from a ConfigMap, so
 * there is no third image to build and publish.
 */
function workspaceContainer(args: BuildWatchPodArgs): V1Container {
  return {
    name: "workspace",
    image: args.image,
    imagePullPolicy: pullPolicyToK8s(args.pullPolicy),
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
    resources: watchResources(args.limits),
    volumeMounts: [
      { name: "workspace", mountPath: WORKSPACE_DIR },
      { name: "telo-cache", mountPath: CACHE_ROOT },
      { name: "workspace-app", mountPath: WORKSPACE_APP_DIR, readOnly: true },
      ...scratchMounts("workspace"),
    ],
    securityContext: hardenedContainerSecurity(),
  };
}

function appContainer(args: BuildWatchPodArgs, app: BackendAppSpec, index: number): V1Container {
  const env = [
    ...Object.entries(args.env).map(([name, value]) => ({ name, value })),
    // Deliberately NO `TELO_CACHE_DIR`: it OUTRANKS the workspace marker, and
    // the marker is what puts every app's cache in one place. The kernel walks
    // up from the entry manifest to `telo-workspace.yaml` (seeded at the
    // workspace root when the session starts) and anchors `.telo` there, so two
    // apps importing the same module resolve it once between them.
    { name: "HOME", value: HOME_DIR },
    { name: "npm_config_cache", value: `${HOME_DIR}/.npm` },
    // Carried as env, not interpolated into the shell line below: a path that
    // reached a command string could close a quote.
    { name: "TELO_ENTRY", value: `${WORKSPACE_DIR}/${app.entryRelativePath}` },
    { name: "TELO_INSPECT_ADDR", value: `0.0.0.0:${inspectPortFor(index)}` },
  ];
  // Only under a terminal. `streams` forces nothing OFF either: with no terminal
  // the precedence order already resolves to no colour, and an explicit
  // NO_COLOR would sit ABOVE an app's own `color: always` and suppress a
  // decision worth observing.
  if (app.io === "tty") env.push({ name: "CLICOLOR_FORCE", value: "1" });

  const tty = app.io === "tty";
  return {
    name: `app-${app.name}`,
    image: args.image,
    imagePullPolicy: pullPolicyToK8s(args.pullPolicy),
    workingDir: WORK_DIR,
    // Wait for the entry manifest before starting. The workspace arrives over
    // the workspace container's HTTP surface once the pod is up, so an app that
    // exec'd immediately would fail its first load on a file that is about to
    // exist and report a generation nobody caused. The same wait covers a
    // resumed pod and an app added to the set before its files are written.
    //
    // `--watch` + `--inspect` compose: one inspect endpoint serves the whole
    // watch session and each rebuilt kernel re-attaches to it, so a reload is a
    // stop/start pair on ONE debug connection — which is exactly what the
    // runner's generation counting reads. 0.0.0.0 (not the CLI's loopback
    // default) lets the runner reach it across the pod network; the port is
    // never published via Service or Ingress.
    command: [
      "sh",
      "-c",
      'while [ ! -f "$TELO_ENTRY" ]; do sleep 0.2; done; ' +
        'exec telo run "$TELO_ENTRY" --watch --inspect "$TELO_INSPECT_ADDR" --no-open',
    ],
    env,
    stdin: true,
    stdinOnce: false,
    tty,
    ...(app.ports.length > 0
      ? {
          ports: app.ports.map((p) => ({
            containerPort: p.port,
            protocol: p.protocol.toUpperCase(),
          })),
        }
      : {}),
    resources: watchResources(args.limits),
    // No `telo-cache` mount: an app's cache lives under the workspace volume,
    // anchored by the marker at its root, which is what makes it one cache for
    // the whole session rather than one per app.
    volumeMounts: [
      { name: "workspace", mountPath: WORKSPACE_DIR },
      ...scratchMounts(app.name),
    ],
    securityContext: hardenedContainerSecurity(),
  };
}

/**
 * At most one agent per session, never per app: the agent's unit is the
 * workspace — it edits files, it does not own a process — and two agents over
 * one workspace would contend on the same files and split one conversation in
 * half.
 *
 * This is the ONLY container that receives the operator env, and the only one
 * whose write-path hardening is relaxed (an operator-curated image, exactly as
 * an app session is today).
 */
function agentContainer(args: BuildWatchPodArgs, agent: ResolvedRunnerApp): V1Container {
  return {
    name: "agent",
    image: agent.image,
    imagePullPolicy: pullPolicyToK8s(agent.pullPolicy),
    env: [
      ...Object.entries(agent.env).map(([name, value]) => ({ name, value })),
      // The agent's own workspace IS the session's shared volume.
      { name: "WORKSPACE_DIR", value: WORKSPACE_DIR },
      { name: "CLICOLOR_FORCE", value: "1" },
    ],
    // Declared so the pod describes what it listens on; the Service selects the
    // pod and every container shares its network namespace, so the agent needs
    // no routing of its own beyond being in the session's port set.
    ...(agent.port !== undefined
      ? { ports: [{ containerPort: agent.port, protocol: "TCP" }] }
      : {}),
    resources: watchResources(args.limits),
    volumeMounts: [
      { name: "workspace", mountPath: WORKSPACE_DIR },
      ...scratchMounts("agent"),
    ],
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    },
  };
}

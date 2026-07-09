import type { V1Pod } from "@kubernetes/client-node";

import type { K8sRunnerConfig } from "../config.js";
import type { ResolvedLimits } from "../limits.js";
import type { PortMapping, PullPolicy } from "@telorun/runner-core";

export interface BuildPodArgs {
  config: K8sRunnerConfig;
  sessionId: string;
  podName: string;
  entryRelativePath: string;
  env: Record<string, string>;
  ports: PortMapping[];
  limits: ResolvedLimits;
  /** Prebuilt per-app image to run. Controllers + module manifests are baked
   *  into `/telo-cache/{manifests,npm}` (read-only) by the on-cluster build;
   *  the image is keyed only on the dependency closure, so the per-session body
   *  is NOT baked — it's delivered to `/app` at boot via the initContainer. */
  image: string;
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
/** Baked, read-only deps (`telo install` output). Set via TELO_CACHE_DIR, NOT
 *  mounted — it lives on the image rootfs, so `telo run --no-cache-write` reads
 *  it without writing. */
const DEPS_DIR = "/telo-cache";
/** Writable HOME / npm scratch under a read-only rootfs. Separate from DEPS_DIR
 *  (which is now read-only baked deps, not scratch). */
const HOME_DIR = "/home/telo";
const TMP_MOUNT = "/tmp";

/**
 * Builds the session Pod. Hardening that needs no RuntimeClass is always on
 * (non-root, read-only rootfs, drop-all caps, no service-account token,
 * seccomp RuntimeDefault); a sandbox RuntimeClass is layered on when configured.
 *
 * The body-delivery initContainer fetches the session bundle into the writable
 * `/app` emptyDir; the session container runs `telo run /app/<entry>
 * --no-cache-write` reading its deps from the baked, read-only `/telo-cache`.
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
  // Read deps from the baked, read-only `/telo-cache`; keep HOME/npm scratch on a
  // separate writable emptyDir under the read-only root filesystem.
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
      // Pull the per-app image from a private registry. The Secret must exist in
      // the session namespace (pull secrets are namespace-scoped).
      ...(config.build.imagePullSecret
        ? { imagePullSecrets: [{ name: config.build.imagePullSecret }] }
        : {}),
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
          // Deliver the per-session body into the writable /app emptyDir. The
          // image bakes only the dependency closure, so the body arrives here.
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
          // The per-app tag is an immutable content hash, so IfNotPresent lets
          // the kubelet reuse a node-cached layer across runs of the same app.
          imagePullPolicy: "IfNotPresent",
          // Run the delivered body by absolute path; `--no-cache-write` reads
          // the baked deps from TELO_CACHE_DIR and validates in-memory without
          // touching the read-only cache. WORK_DIR is a writable emptyDir cwd so
          // the workload's relative paths resolve under readOnlyRootFilesystem.
          workingDir: WORK_DIR,
          // 0.0.0.0 (not the CLI's loopback default) lets the runner reach the
          // debug server across the pod network; the port is never published.
          command: [
            "telo",
            "run",
            `${APP_DIR}/${args.entryRelativePath}`,
            "--no-cache-write",
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
            { name: "work", mountPath: WORK_DIR },
            { name: "home", mountPath: HOME_DIR },
            { name: "tmp", mountPath: TMP_MOUNT },
          ],
          securityContext: hardenedContainerSecurity(),
        },
      ],
      volumes: [
        { name: "app", emptyDir: {} },
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
      ...(config.build.imagePullSecret
        ? { imagePullSecrets: [{ name: config.build.imagePullSecret }] }
        : {}),
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

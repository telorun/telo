import type { V1Pod } from "@kubernetes/client-node";

import type { K8sRunnerConfig } from "../config.js";
import type { ResolvedLimits } from "../limits.js";
import type { PortMapping } from "@telorun/runner-core";

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
}

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
          command: ["telo", "run", `${APP_DIR}/${args.entryRelativePath}`, "--no-cache-write"],
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

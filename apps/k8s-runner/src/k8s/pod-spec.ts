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
  /** Prebuilt per-app image to run — controllers + module manifests baked into
   *  /app/.telo by the on-cluster build. */
  image: string;
}

const WORK_DIR = "/work";
const CACHE_MOUNT = "/telo-cache";
const TMP_MOUNT = "/tmp";

/**
 * Builds the session Pod. Hardening that needs no RuntimeClass is always on
 * (non-root, read-only rootfs, drop-all caps, no service-account token,
 * seccomp RuntimeDefault); a sandbox RuntimeClass is layered on when configured.
 *
 * `args.image` is the prebuilt per-app image — controllers + module manifests
 * are baked into /app/.telo by the on-cluster build, so `telo run` resolves
 * everything from disk: no initContainer, no install on the start path.
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
  // Writable locations for telo / npm under a read-only root filesystem.
  envVars.push({ name: "TELO_CACHE_DIR", value: CACHE_MOUNT });
  envVars.push({ name: "HOME", value: CACHE_MOUNT });
  envVars.push({ name: "npm_config_cache", value: `${CACHE_MOUNT}/.npm` });
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
      containers: [
        {
          name: "session",
          image: args.image,
          // The per-app tag is an immutable content hash, so IfNotPresent lets
          // the kubelet reuse a node-cached layer across runs of the same app.
          imagePullPolicy: "IfNotPresent",
          // Run the manifest by absolute path so `telo run` anchors its
          // install-root to the baked /app/.telo (read-only, cache-only — no
          // writes). WORK_DIR is a writable emptyDir set as cwd so the
          // workload's own relative paths resolve somewhere writable under
          // readOnlyRootFilesystem.
          workingDir: WORK_DIR,
          command: ["telo", "run", `/app/${args.entryRelativePath}`],
          env: envVars,
          stdin: true,
          stdinOnce: false,
          tty: true,
          ...(args.ports.length > 0
            ? { ports: args.ports.map((p) => ({ containerPort: p.port, protocol: p.protocol.toUpperCase() })) }
            : {}),
          resources,
          volumeMounts: [
            { name: "work", mountPath: WORK_DIR },
            // Writable scratch for HOME/npm under a read-only rootfs. Controllers
            // live in the image, so nothing is installed here at runtime.
            { name: "telo-cache", mountPath: CACHE_MOUNT },
            { name: "tmp", mountPath: TMP_MOUNT },
          ],
          securityContext: hardenedContainerSecurity(),
        },
      ],
      volumes: [
        { name: "work", emptyDir: {} },
        { name: "telo-cache", emptyDir: {} },
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

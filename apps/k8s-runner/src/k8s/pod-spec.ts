import type { V1Pod } from "@kubernetes/client-node";

import type { K8sRunnerConfig } from "../config.js";
import type { ResolvedLimits } from "../limits.js";
import type { PortMapping, SessionConfig } from "@telorun/runner-core";

export interface BuildPodArgs {
  config: K8sRunnerConfig;
  sessionId: string;
  podName: string;
  entryRelativePath: string;
  env: Record<string, string>;
  ports: PortMapping[];
  session: SessionConfig;
  limits: ResolvedLimits;
  /** Tokenized URL the initContainer fetches the bundle tarball from. */
  bundleUrl: string;
}

const WORK_DIR = "/work";
const CACHE_MOUNT = "/telo-cache";
const TMP_MOUNT = "/tmp";

/**
 * Builds the session Pod. Hardening that needs no RuntimeClass is always on
 * (non-root, read-only rootfs, drop-all caps, no service-account token,
 * seccomp RuntimeDefault); a sandbox RuntimeClass is layered on when configured.
 * The bundle is delivered by an initContainer that fetches a tarball into a
 * shared emptyDir.
 *
 * NOTE: telo's dependency cache is a PER-POD emptyDir, not a shared volume. A
 * writable cache shared across tenants would be a cross-tenant poisoning channel
 * (untrusted session code writing entries the next user warm-mounts and runs) —
 * exactly what the plan's "session pod consumes read-only" decision forbids.
 * Per-node shared caching is deferred to the trusted content-addressed build Job
 * (`config.cacheRoot` is reserved for it); until then each pod resolves fresh.
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
          name: "bundle-fetch",
          image: config.initImage,
          // Fetch the tokenized bundle tarball and unpack it into the shared
          // work dir. `set -e` so a fetch failure fails the Pod loudly.
          command: ["sh", "-c"],
          args: [
            // busybox sh has no reliable pipefail, so download to a file first
            // and fail the Pod loudly on a fetch error rather than unpacking an
            // empty pipe and letting `telo run` fail later with a confusing error.
            `set -e; mkdir -p ${WORK_DIR}/${args.sessionId}; ` +
              `wget -qO ${TMP_MOUNT}/bundle.tgz "${args.bundleUrl}"; ` +
              `tar xzf ${TMP_MOUNT}/bundle.tgz -C ${WORK_DIR}/${args.sessionId}`,
          ],
          volumeMounts: [
            { name: "work", mountPath: WORK_DIR },
            { name: "tmp", mountPath: TMP_MOUNT },
          ],
          securityContext: hardenedContainerSecurity(),
        },
      ],
      containers: [
        {
          name: "session",
          image: args.session.image || config.defaultImage,
          imagePullPolicy: mapPullPolicy(args.session.pullPolicy),
          workingDir: `${WORK_DIR}/${args.sessionId}`,
          command: ["telo", "run", `./${args.entryRelativePath}`],
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
            // Per-pod cache (emptyDir) — NOT shared across tenants. See the
            // class comment: a shared writable cache would be a poisoning hole.
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

function mapPullPolicy(policy: SessionConfig["pullPolicy"]): string {
  switch (policy) {
    case "always":
      return "Always";
    case "never":
      return "Never";
    default:
      return "IfNotPresent";
  }
}

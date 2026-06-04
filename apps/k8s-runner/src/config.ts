import {
  loadCoreConfig,
  parsePositiveInt,
  RunnerConfigError,
  type RunnerCoreConfig,
} from "@telorun/runner-core";

export { RunnerConfigError };

/**
 * Resource limits the runner will ever grant. These are HARD CEILINGS, not
 * defaults a request can exceed: the effective per-session value is
 * `min(requested, ceiling)` (clamp-down only). For a bare runner serving an
 * anonymous tier directly, the ceiling IS the policy.
 */
export interface LimitCeilings {
  /** Kubernetes CPU quantity, e.g. "50m". */
  cpu: string;
  /** Kubernetes memory quantity, e.g. "100Mi". */
  memory: string;
  /** Wall-clock TTL in seconds (Pod activeDeadlineSeconds). */
  ttlSeconds: number;
  /** Per-Pod ephemeral-storage limit, e.g. "512Mi". */
  ephemeralStorage: string;
}

export interface K8sRunnerConfig extends RunnerCoreConfig {
  /** Namespace where session Pods/Services/Ingresses are created. */
  sessionNamespace: string;
  /** Default image for spawned session Pods (telorun/node). */
  defaultImage: string;
  /** Small image for the bundle-fetch initContainer (needs wget + tar). */
  initImage: string;
  /** Optional sandbox RuntimeClass (gvisor/kata). Unset → cluster default (runc). */
  runtimeClass?: string;
  /** Wildcard base domain for per-session ingress; unset → logs-only. */
  ingressBaseDomain?: string;
  /** Optional IngressClass name for created Ingresses. */
  ingressClassName?: string;
  /** Reserved for a future shared `.telo` dependency cache (trusted build path,
   *  e.g. hostPath or other node-local storage). Today session pods use a
   *  per-pod emptyDir cache and this value is not mounted. */
  cacheRoot: string;
  /** Runner's own in-cluster base URL, used to build the bundle fetch URL the
   *  session initContainer curls (e.g. http://k8s-runner.telo-runner:8062). */
  selfUrl: string;
  /** Label applied to every session object, used for orphan reaping. */
  managedByLabel: string;
  limits: LimitCeilings;
}

const DEFAULT_PORT = 8062;

export function loadK8sRunnerConfig(env: NodeJS.ProcessEnv): K8sRunnerConfig {
  const selfUrl = env.RUNNER_SELF_URL?.trim();
  if (!selfUrl) {
    throw new RunnerConfigError(
      "RUNNER_SELF_URL env var is required. Set it to the runner's in-cluster base URL " +
        "(e.g. http://k8s-runner.telo-runner.svc:8062) so session initContainers can fetch the bundle.",
    );
  }

  return {
    ...loadCoreConfig(env, { port: DEFAULT_PORT }),
    sessionNamespace: env.RUNNER_SESSION_NAMESPACE?.trim() || "telo-sessions",
    defaultImage: env.RUNNER_IMAGE?.trim() || "telorun/node:latest-slim",
    initImage: env.RUNNER_INIT_IMAGE?.trim() || "busybox:stable",
    runtimeClass: env.RUNNER_RUNTIME_CLASS?.trim() || undefined,
    ingressBaseDomain: env.RUNNER_INGRESS_BASE_DOMAIN?.trim() || undefined,
    ingressClassName: env.RUNNER_INGRESS_CLASS?.trim() || undefined,
    cacheRoot: env.RUNNER_CACHE_ROOT?.trim() || "/var/lib/telo-cache",
    selfUrl: selfUrl.replace(/\/+$/, ""),
    managedByLabel: env.RUNNER_MANAGED_BY?.trim() || "telo-k8s-runner",
    limits: {
      cpu: env.RUNNER_MAX_CPU?.trim() || "50m",
      memory: env.RUNNER_MAX_MEMORY?.trim() || "100Mi",
      ttlSeconds: parsePositiveInt(env.RUNNER_MAX_TTL_SECONDS, 3600, "RUNNER_MAX_TTL_SECONDS"),
      ephemeralStorage: env.RUNNER_MAX_EPHEMERAL_STORAGE?.trim() || "512Mi",
    },
  };
}

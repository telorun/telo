import {
  loadCoreConfig,
  parseBool,
  parsePositiveInt,
  RunnerConfigError,
  type RunnerCoreConfig,
  type TagFilter,
} from "@telorun/runner-core";

export { RunnerConfigError };

/**
 * Base-image catalog settings. The runner resolves the menu of base images a
 * session may pick from `telorun/node`'s Docker Hub tags (configurable repo),
 * filtered to taste, and advertises it as an editable `image` picker. The
 * configured `defaultImage` is always offered (and is the fallback when Docker
 * Hub is unreachable). Disable to lock `image` to `defaultImage` (the old
 * server-enforced behaviour) — e.g. an air-gapped cluster.
 */
export interface BaseImageCatalogConfig {
  enabled: boolean;
  /** `namespace/repository` queried on Docker Hub, e.g. `telorun/node`. */
  repository: string;
  filter: TagFilter;
  /** Cap on advertised tags (newest first). */
  limit: number;
  /** Background refresh cadence in ms. */
  refreshIntervalMs: number;
}

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

/**
 * On-cluster image-build settings. The runner ALWAYS prebuilds a self-contained
 * per-app image (controllers + module manifests baked in via `telo install`) and
 * the session pod runs it directly — there is no in-pod install fallback, so a
 * registry repository (`RUNNER_IMAGE_REPOSITORY`) is required.
 */
export interface ImageBuildConfig {
  /** Registry repository the per-app image is pushed to / pulled from; the tag
   *  is the bundle content hash (e.g. `registry.telo-runner.svc:5000/telo-sessions`). */
  repository: string;
  /** Namespace the trusted Kaniko build Jobs run in (registry egress lives here). */
  namespace: string;
  /** Builder image — Kaniko (or a compatible `--context`/`--destination` executor). */
  builderImage: string;
  /** Build Job `activeDeadlineSeconds` and the runner's wait budget. */
  timeoutSeconds: number;
  /** Push/pull to an insecure (HTTP / self-signed) registry — the in-cluster default. */
  insecureRegistry: boolean;
  /** HTTP(S) base for a best-effort manifest existence check (skip build on hit);
   *  undefined → always build. */
  registryApiUrl?: string;
  /** Telo module registry `telo install` resolves manifests from during the build. */
  teloRegistryUrl: string;
  /** Optional dockerconfig Secret (in the build namespace) Kaniko pushes with. */
  pushSecretName?: string;
  /** Optional dockerconfig Secret (in the session namespace) the kubelet uses to
   *  pull per-app images from a private registry. */
  imagePullSecret?: string;
}

export interface K8sRunnerConfig extends RunnerCoreConfig {
  /** Namespace where session Pods/Services/Ingresses are created. */
  sessionNamespace: string;
  /** Default image for spawned session Pods (telorun/node). */
  defaultImage: string;
  /** Small image for the bundle/build-context fetch initContainer (needs wget + tar). */
  initImage: string;
  /** Optional sandbox RuntimeClass (gvisor/kata). Unset → cluster default (runc). */
  runtimeClass?: string;
  /** Wildcard base domain for per-session ingress; unset → logs-only. */
  sessionIngressBaseDomain?: string;
  /** Optional IngressClass name for created session Ingresses. */
  sessionIngressClassName?: string;
  /** Optional `kubernetes.io/tls` Secret (in the session namespace) the per-session
   *  Ingress presents so an upstream (e.g. Cloudflare Full (Strict)) can validate
   *  the origin. Must cover the wildcard `*.<sessionIngressBaseDomain>`. Unset → no TLS block. */
  sessionIngressTlsSecretName?: string;
  /** On-cluster image build — the only delivery path (always present). */
  build: ImageBuildConfig;
  /** Runner's own in-cluster base URL, used to build the bundle/build-context
   *  fetch URL the initContainer curls (e.g. http://k8s-runner.telo-runner:8062). */
  selfUrl: string;
  /** Label applied to every session object, used for orphan reaping. */
  managedByLabel: string;
  limits: LimitCeilings;
  /** Menu of base images a session may pick (advertised as the `image` enum). */
  baseImageCatalog: BaseImageCatalogConfig;
}

const DEFAULT_PORT = 8062;

/** Compile a single optional regex env var into a one-element `RegExp[]`. */
function parseTagRegex(raw: string | undefined, field: string): RegExp[] | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  try {
    return [new RegExp(v)];
  } catch (err) {
    throw new RunnerConfigError(
      `${field} is not a valid regular expression: ${(err as Error).message}`,
    );
  }
}

function loadBaseImageCatalogConfig(env: NodeJS.ProcessEnv): BaseImageCatalogConfig {
  return {
    enabled: parseBool(env.RUNNER_BASE_IMAGE_CATALOG_ENABLED, true, "RUNNER_BASE_IMAGE_CATALOG_ENABLED"),
    repository: env.RUNNER_BASE_IMAGE_REPO?.trim() || "telorun/node",
    filter: {
      pinnedOnly: parseBool(env.RUNNER_BASE_IMAGE_PINNED_ONLY, true, "RUNNER_BASE_IMAGE_PINNED_ONLY"),
      excludeSha: parseBool(env.RUNNER_BASE_IMAGE_EXCLUDE_SHA, true, "RUNNER_BASE_IMAGE_EXCLUDE_SHA"),
      excludePrerelease: parseBool(
        env.RUNNER_BASE_IMAGE_EXCLUDE_PRERELEASE,
        true,
        "RUNNER_BASE_IMAGE_EXCLUDE_PRERELEASE",
      ),
      include: parseTagRegex(env.RUNNER_BASE_IMAGE_INCLUDE, "RUNNER_BASE_IMAGE_INCLUDE"),
      exclude: parseTagRegex(env.RUNNER_BASE_IMAGE_EXCLUDE, "RUNNER_BASE_IMAGE_EXCLUDE"),
    },
    limit: parsePositiveInt(env.RUNNER_BASE_IMAGE_LIMIT, 20, "RUNNER_BASE_IMAGE_LIMIT"),
    refreshIntervalMs:
      parsePositiveInt(
        env.RUNNER_BASE_IMAGE_REFRESH_SECONDS,
        3600,
        "RUNNER_BASE_IMAGE_REFRESH_SECONDS",
      ) * 1000,
  };
}

export function loadK8sRunnerConfig(env: NodeJS.ProcessEnv): K8sRunnerConfig {
  const selfUrl = env.RUNNER_SELF_URL?.trim();
  if (!selfUrl) {
    throw new RunnerConfigError(
      "RUNNER_SELF_URL env var is required. Set it to the runner's in-cluster base URL " +
        "(e.g. http://k8s-runner.telo-runner.svc:8062) so session initContainers can fetch the bundle.",
    );
  }

  const repository = env.RUNNER_IMAGE_REPOSITORY?.trim();
  if (!repository) {
    throw new RunnerConfigError(
      "RUNNER_IMAGE_REPOSITORY env var is required. The runner prebuilds a per-app session image for " +
        "every run (there is no in-pod install fallback); set it to the registry repository the built " +
        "images are pushed to / pulled from (e.g. registry.example.com/telo-sessions). The tag is the " +
        "bundle content hash.",
    );
  }
  const build: ImageBuildConfig = {
    repository: repository.replace(/\/+$/, ""),
    namespace: env.RUNNER_BUILD_NAMESPACE?.trim() || "telo-builds",
    builderImage: env.RUNNER_BUILDER_IMAGE?.trim() || "gcr.io/kaniko-project/executor:latest",
    timeoutSeconds: parsePositiveInt(
      env.RUNNER_BUILD_TIMEOUT_SECONDS,
      600,
      "RUNNER_BUILD_TIMEOUT_SECONDS",
    ),
    insecureRegistry: env.RUNNER_REGISTRY_INSECURE?.trim() === "true",
    registryApiUrl: env.RUNNER_REGISTRY_API_URL?.trim() || undefined,
    teloRegistryUrl: env.TELO_REGISTRY_URL?.trim() || "https://registry.telo.run",
    pushSecretName: env.RUNNER_REGISTRY_PUSH_SECRET?.trim() || undefined,
    imagePullSecret: env.RUNNER_IMAGE_PULL_SECRET?.trim() || undefined,
  };

  return {
    ...loadCoreConfig(env, { port: DEFAULT_PORT }),
    sessionNamespace: env.RUNNER_SESSION_NAMESPACE?.trim() || "telo-sessions",
    defaultImage: env.RUNNER_IMAGE?.trim() || "telorun/node:latest-slim",
    initImage: env.RUNNER_INIT_IMAGE?.trim() || "busybox:stable",
    runtimeClass: env.RUNNER_RUNTIME_CLASS?.trim() || undefined,
    sessionIngressBaseDomain: env.SESSION_INGRESS_BASE_DOMAIN?.trim() || undefined,
    sessionIngressClassName: env.SESSION_INGRESS_CLASS?.trim() || undefined,
    sessionIngressTlsSecretName: env.SESSION_INGRESS_TLS_SECRET?.trim() || undefined,
    build,
    selfUrl: selfUrl.replace(/\/+$/, ""),
    managedByLabel: env.RUNNER_MANAGED_BY?.trim() || "telo-k8s-runner",
    limits: {
      cpu: env.RUNNER_MAX_CPU?.trim() || "50m",
      memory: env.RUNNER_MAX_MEMORY?.trim() || "100Mi",
      ttlSeconds: parsePositiveInt(env.RUNNER_MAX_TTL_SECONDS, 3600, "RUNNER_MAX_TTL_SECONDS"),
      ephemeralStorage: env.RUNNER_MAX_EPHEMERAL_STORAGE?.trim() || "512Mi",
    },
    baseImageCatalog: loadBaseImageCatalogConfig(env),
  };
}

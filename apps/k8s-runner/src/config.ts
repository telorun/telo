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
 * Which routing layer the runner publishes per-session routes on.
 *
 *  - `auto`    — resolve from what is CONFIGURED, then from what the cluster
 *                serves; refuse at boot when the answer is genuinely ambiguous.
 *  - `ingress` — `networking.k8s.io/v1` Ingress.
 *  - `gateway` — `gateway.networking.k8s.io/v1` HTTPRoute.
 *  - `none`    — publish nothing; the session is logs-only even with a base
 *                domain set.
 */
export type SessionRoutingMode = "auto" | "ingress" | "gateway" | "none";

const ROUTING_MODES: readonly SessionRoutingMode[] = ["auto", "ingress", "gateway", "none"];

/** The Gateway a session's HTTPRoute attaches to. Never detected: picking one of
 *  several Gateways is the same guess as picking one of two routing APIs, and a
 *  route attached to the wrong Gateway fails exactly as silently as no route. */
export interface GatewayParentConfig {
  name: string;
  /** Defaults to the session namespace — mirroring Gateway API's own
   *  `parentRefs[].namespace` default, which is the route's own namespace. */
  namespace: string;
  /** Optional listener name, when the Gateway has several and only one should
   *  carry session traffic. */
  sectionName?: string;
}

export interface SessionRoutingConfig {
  mode: SessionRoutingMode;
  /** Wildcard base domain for per-session hosts; unset → logs-only whatever the
   *  mode, since without it no host can be constructed at all. */
  baseDomain?: string;
  /** IngressClass for created session Ingresses (ingress mode). */
  ingressClassName?: string;
  /** `kubernetes.io/tls` Secret (in the session namespace) the per-session
   *  Ingress presents so an upstream (e.g. Cloudflare Full (Strict)) can validate
   *  the origin. Must cover `*.<baseDomain>`. INGRESS MODE ONLY — under Gateway
   *  API the certificate belongs to the Gateway's listener, so setting this in
   *  gateway mode is refused at boot rather than silently ignored. */
  tlsSecretName?: string;
  gateway?: GatewayParentConfig;
  /** How long a published route may go unclaimed by any controller before it is
   *  reported `unprogrammed`. */
  routeReadyTimeoutMs: number;
}

export interface K8sRunnerConfig extends RunnerCoreConfig {
  /** Identity advertised on `/v1/capabilities` — studio labels the runner
   *  with these. */
  displayName: string;
  description: string;
  /** Namespace where session Pods/Services and routing objects are created. */
  sessionNamespace: string;
  /** Default image for spawned session Pods (telorun/node). Baked into the runner
   *  image as `RUNNER_IMAGE` at build time (the kernel version the runner was
   *  built against); the literal fallback below is for a source checkout only. */
  defaultImage: string;
  /** Small image for the bundle-fetch initContainer (needs wget + tar). */
  initImage: string;
  /** Optional dockerconfig Secret (in the session namespace) the kubelet pulls
   *  session images with — the kernel image, and any operator catalog image
   *  (`RUNNER_APPS`) held in a private registry. */
  imagePullSecret?: string;
  /** Optional sandbox RuntimeClass (gvisor/kata). Unset → cluster default (runc). */
  runtimeClass?: string;
  /** How per-session routes are published. */
  sessionRouting: SessionRoutingConfig;
  /** Runner's own in-cluster base URL, used to build the bundle fetch URL the
   *  initContainer curls (e.g. http://k8s-runner.telo-runner:8062). */
  selfUrl: string;
  /** Label applied to every session object, used for orphan reaping. */
  managedByLabel: string;
  limits: LimitCeilings;
  /** Ceilings for operator-predefined app sessions (`RUNNER_APPS`). Separate
   *  from `limits` — apps are operator-curated and long-lived, so they get
   *  roomier defaults than anonymous session code without loosening the
   *  anonymous ceiling. */
  appLimits: LimitCeilings;
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

/** Parse the routing mode, THROWING on an unrecognized one rather than degrading
 *  to a default — a typo'd mode that silently fell back to `auto` is the same
 *  class of failure this whole mechanism exists to remove. */
function parseRoutingMode(raw: string | undefined): SessionRoutingMode {
  const v = raw?.trim();
  if (!v) return "auto";
  if ((ROUTING_MODES as readonly string[]).includes(v)) return v as SessionRoutingMode;
  throw new RunnerConfigError(
    `SESSION_ROUTING_MODE must be one of ${ROUTING_MODES.join(" | ")} (got '${v}').`,
  );
}

function loadSessionRoutingConfig(
  env: NodeJS.ProcessEnv,
  sessionNamespace: string,
): SessionRoutingConfig {
  const mode = parseRoutingMode(env.SESSION_ROUTING_MODE);
  const gatewayName = env.SESSION_GATEWAY_NAME?.trim() || undefined;
  const tlsSecretName = env.SESSION_INGRESS_TLS_SECRET?.trim() || undefined;

  // A certificate configured for a layer that will never present it is a silent
  // downgrade to plaintext origin traffic, so it is refused rather than ignored.
  // This is only the FAST PATH, for the mode that states the layer outright: the
  // authoritative refusal is at routing resolution, because under `auto` a named
  // Gateway decides the layer and nothing here can see that yet.
  if (mode === "gateway" && tlsSecretName) {
    throw new RunnerConfigError(
      "SESSION_INGRESS_TLS_SECRET is set but SESSION_ROUTING_MODE=gateway. Under Gateway API the " +
        "origin certificate belongs to the Gateway listener's own `tls.certificateRefs`, not to the " +
        "per-session route. Move the Secret reference to the Gateway and unset this.",
    );
  }
  if (mode === "gateway" && !gatewayName) {
    throw new RunnerConfigError(
      "SESSION_ROUTING_MODE=gateway requires SESSION_GATEWAY_NAME — the Gateway each session's " +
        "HTTPRoute attaches to. Set it (and SESSION_GATEWAY_NAMESPACE when the Gateway is not in " +
        `'${sessionNamespace}').`,
    );
  }

  return {
    mode,
    baseDomain: env.SESSION_ROUTING_BASE_DOMAIN?.trim() || undefined,
    ingressClassName: env.SESSION_INGRESS_CLASS?.trim() || undefined,
    tlsSecretName,
    ...(gatewayName
      ? {
          gateway: {
            name: gatewayName,
            namespace: env.SESSION_GATEWAY_NAMESPACE?.trim() || sessionNamespace,
            sectionName: env.SESSION_GATEWAY_SECTION_NAME?.trim() || undefined,
          },
        }
      : {}),
    routeReadyTimeoutMs:
      parsePositiveInt(
        env.SESSION_ROUTE_READY_TIMEOUT_SECONDS,
        60,
        "SESSION_ROUTE_READY_TIMEOUT_SECONDS",
      ) * 1000,
  };
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

  const sessionNamespace = env.RUNNER_SESSION_NAMESPACE?.trim() || "telo-sessions";

  return {
    ...loadCoreConfig(env, { port: DEFAULT_PORT }),
    displayName: env.RUNNER_DISPLAY_NAME?.trim() || "Telo Runner",
    description:
      env.RUNNER_DESCRIPTION?.trim() || "Runs the Telo application in a cloud environment",
    sessionNamespace,
    defaultImage: env.RUNNER_IMAGE?.trim() || "telorun/node:latest-slim",
    initImage: env.RUNNER_INIT_IMAGE?.trim() || "busybox:stable",
    imagePullSecret: env.RUNNER_IMAGE_PULL_SECRET?.trim() || undefined,
    runtimeClass: env.RUNNER_RUNTIME_CLASS?.trim() || undefined,
    sessionRouting: loadSessionRoutingConfig(env, sessionNamespace),
    selfUrl: selfUrl.replace(/\/+$/, ""),
    managedByLabel: env.RUNNER_MANAGED_BY?.trim() || "telo-k8s-runner",
    // Sized for a pod that RESOLVES ITS OWN module closure. They used to be
    // 50m / 100Mi / 512Mi, which described a different workload: the closure
    // arrived in image layers, so the pod only ran it. It now downloads,
    // unpacks and resolves it in-pod, into an emptyDir that counts against
    // ephemeral-storage — so the old numbers meant an OOMKill on the memory
    // ceiling and an eviction on the storage one, for the ordinary case. The
    // watch path already ran this workload and already carried the roomier
    // ceiling; these match it. `appLimits` stays separate: it still differs in
    // TTL, and both remain the operator's policy to tighten.
    limits: {
      cpu: env.RUNNER_MAX_CPU?.trim() || "500m",
      memory: env.RUNNER_MAX_MEMORY?.trim() || "512Mi",
      ttlSeconds: parsePositiveInt(env.RUNNER_MAX_TTL_SECONDS, 3600, "RUNNER_MAX_TTL_SECONDS"),
      ephemeralStorage: env.RUNNER_MAX_EPHEMERAL_STORAGE?.trim() || "1Gi",
    },
    appLimits: {
      cpu: env.RUNNER_APP_MAX_CPU?.trim() || "500m",
      memory: env.RUNNER_APP_MAX_MEMORY?.trim() || "512Mi",
      ttlSeconds: parsePositiveInt(
        env.RUNNER_APP_MAX_TTL_SECONDS,
        21600,
        "RUNNER_APP_MAX_TTL_SECONDS",
      ),
      ephemeralStorage: env.RUNNER_APP_MAX_EPHEMERAL_STORAGE?.trim() || "1Gi",
    },
    baseImageCatalog: loadBaseImageCatalogConfig(env),
  };
}

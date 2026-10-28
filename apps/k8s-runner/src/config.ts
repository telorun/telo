import { loadTeloImageSource, type TeloImageSource } from "@telorun/runner-core/container";
import {
  loadCoreConfig,
  parseBool,
  parsePositiveInt,
  requireStateDirectory,
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
 * Resource limits the runner will ever grant one container. These are HARD
 * CEILINGS, not defaults a request can exceed: the effective value is
 * `min(requested, ceiling)` (clamp-down only). For a bare runner serving an
 * anonymous tier directly, the ceiling IS the policy.
 */
export interface LimitCeilings {
  /** Kubernetes CPU quantity, e.g. "500m". */
  cpu: string;
  /** Kubernetes memory quantity, e.g. "512Mi". */
  memory: string;
  /** Per-container ephemeral-storage limit, e.g. "1Gi". */
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
  /** The image pull policy of the session's containers (`RUNNER_PULL_POLICY`). */
  teloImages: TeloImageSource;
  /** Where the `telo` binary of a version an application names is downloaded
   *  from: `<url>/v<version>/telo-<version>-<target>.tar.gz` and its
   *  `checksums.txt` (`RUNNER_TELO_RELEASES_URL`). Point it at a mirror where the
   *  session pods cannot reach GitHub. */
  teloReleasesUrl: string;
  /** The runner's own image (`RUNNER_SUPERVISOR_IMAGE`): a session pod's
   *  `supervisor` init container copies the session supervisor out of it. */
  supervisorImage: string;
  /** Optional dockerconfig Secret (in the session namespace) the kubelet pulls
   *  session images with — the kernel image, and any operator catalog image
   *  (`AGENT_IMAGE`) held in a private registry. */
  imagePullSecret?: string;
  /** Leave a session pod that failed to start in place for inspection
   *  (`RUNNER_KEEP_FAILED_PODS`). */
  keepFailedPods: boolean;
  /** Optional sandbox RuntimeClass (gvisor/kata). Unset → cluster default (runc). */
  runtimeClass?: string;
  /** How per-session routes are published. */
  sessionRouting: SessionRoutingConfig;
  /** Label applied to every session object, used for orphan reaping. */
  managedByLabel: string;
  /** Ceilings of each `app-<name>` container and the `workspace` container
   *  (`RUNNER_MAX_*`). */
  limits: LimitCeilings;
  /** Ceilings of the co-resident agent's container (`RUNNER_APP_MAX_*`): an
   *  operator-curated image, sized separately from anonymous session code. */
  appLimits: LimitCeilings;
  /** Menu of base images a session may pick (advertised as the `image` enum). */
  baseImageCatalog: BaseImageCatalogConfig;
  /** The resources of every pod a session starts through its container engine
   *  (`RUNNER_SESSION_CONTAINERS_RESOURCES`, a pod container's `resources` as
   *  JSON). Always set: the session namespace's quota admits no pod without
   *  limits. */
  sessionContainerResources: ContainerResources;
  /** Each session's own volume (`RUNNER_SESSION_STORAGE_SIZE`,
   *  `RUNNER_SESSION_STORAGE_CLASS`). */
  sessionStorage: SessionStorageConfig;
}

export interface SessionStorageConfig {
  /** A Kubernetes storage quantity, e.g. `5Gi`. */
  size: string;
  /** StorageClass name; undefined is the cluster's default class. */
  storageClassName?: string;
}

const STORAGE_QUANTITY = /^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/;
// A DNS subdomain (RFC 1123), which a StorageClass name must be.
const STORAGE_CLASS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

function loadSessionStorageConfig(env: NodeJS.ProcessEnv): SessionStorageConfig {
  const size = env.RUNNER_SESSION_STORAGE_SIZE?.trim() || "5Gi";
  if (!STORAGE_QUANTITY.test(size) || Number.parseFloat(size) <= 0) {
    throw new RunnerConfigError(
      `RUNNER_SESSION_STORAGE_SIZE must be a positive Kubernetes storage quantity such as 5Gi or 500Mi, got '${size}'.`,
    );
  }
  const storageClassName = env.RUNNER_SESSION_STORAGE_CLASS?.trim() || undefined;
  if (storageClassName !== undefined && (storageClassName.length > 253 || !STORAGE_CLASS_NAME.test(storageClassName))) {
    throw new RunnerConfigError(
      `RUNNER_SESSION_STORAGE_CLASS must be a StorageClass name (lowercase letters, digits, '-' and '.'), ` +
        `got '${storageClassName}'. Unset it to use the cluster's default class.`,
    );
  }
  return { size, storageClassName };
}

/** A pod container's `resources`, quantities as strings. */
export interface ContainerResources {
  limits: Record<string, string>;
  requests: Record<string, string>;
}

const DEFAULT_SESSION_CONTAINER_RESOURCES: ContainerResources = {
  limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "1Gi" },
  requests: { cpu: "500m", memory: "512Mi" },
};

function loadSessionContainerResources(raw: string | undefined): ContainerResources {
  const text = raw?.trim();
  if (!text) return DEFAULT_SESSION_CONTAINER_RESOURCES;
  const fail = (detail: string): never => {
    throw new RunnerConfigError(
      `RUNNER_SESSION_CONTAINERS_RESOURCES must be a pod container's resources as JSON ` +
        `({"limits": {...}, "requests": {...}}, quantities as strings): ${detail}`,
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail("not an object");
  const resources: ContainerResources = { limits: {}, requests: {} };
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "limits" && key !== "requests") return fail(`unknown key '${key}'`);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail(`'${key}' is not an object`);
    }
    for (const [name, quantity] of Object.entries(value)) {
      if (typeof quantity !== "string" && typeof quantity !== "number") {
        return fail(`'${key}.${name}' is not a quantity`);
      }
      resources[key][name] = String(quantity);
    }
  }
  return resources;
}

const DEFAULT_PORT = 8062;

/** Variables this runner read before sessions became durable workspaces. */
const RETIRED_VARIABLES: Record<string, string> = {
  RUNNER_SELF_URL:
    "it served the bundle fetch, which is gone: a session's files arrive through its workspace. " +
    "Session containers reach the runner through RUNNER_INTERNAL_URL",
  RUNNER_INIT_IMAGE:
    "it ran the bundle fetch, which is gone; a session pod's init container runs RUNNER_SUPERVISOR_IMAGE",
};

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
  for (const [name, why] of Object.entries(RETIRED_VARIABLES)) {
    if (env[name] !== undefined) {
      throw new RunnerConfigError(`${name} is no longer read and must be unset: ${why}.`);
    }
  }
  const supervisorImage = env.RUNNER_SUPERVISOR_IMAGE?.trim();
  if (!supervisorImage) {
    throw new RunnerConfigError(
      "RUNNER_SUPERVISOR_IMAGE is required: the runner's own image, which every session pod's " +
        "`supervisor` init container copies the session supervisor from (the Helm chart sets it).",
    );
  }

  const sessionNamespace = env.RUNNER_SESSION_NAMESPACE?.trim() || "telo-sessions";
  const core = loadCoreConfig(env, { port: DEFAULT_PORT });
  requireStateDirectory(core.sessionStore);

  return {
    ...core,
    displayName: env.RUNNER_DISPLAY_NAME?.trim() || "Telo Runner",
    description:
      env.RUNNER_DESCRIPTION?.trim() || "Runs the Telo application in a cloud environment",
    sessionNamespace,
    defaultImage: env.RUNNER_IMAGE?.trim() || "telorun/node:latest-slim",
    teloImages: loadTeloImageSource(env),
    teloReleasesUrl: (
      env.RUNNER_TELO_RELEASES_URL?.trim() || "https://github.com/telorun/telo/releases/download"
    ).replace(/\/+$/, ""),
    supervisorImage,
    imagePullSecret: env.RUNNER_IMAGE_PULL_SECRET?.trim() || undefined,
    runtimeClass: env.RUNNER_RUNTIME_CLASS?.trim() || undefined,
    keepFailedPods: parseBool(env.RUNNER_KEEP_FAILED_PODS, false, "RUNNER_KEEP_FAILED_PODS"),
    sessionRouting: loadSessionRoutingConfig(env, sessionNamespace),
    managedByLabel: env.RUNNER_MANAGED_BY?.trim() || "telo-k8s-runner",
    // Sized for a container that resolves its own module closure into the
    // session's storage; both remain the operator's policy to tighten.
    limits: {
      cpu: env.RUNNER_MAX_CPU?.trim() || "500m",
      memory: env.RUNNER_MAX_MEMORY?.trim() || "512Mi",
      ephemeralStorage: env.RUNNER_MAX_EPHEMERAL_STORAGE?.trim() || "1Gi",
    },
    appLimits: {
      cpu: env.RUNNER_APP_MAX_CPU?.trim() || "500m",
      memory: env.RUNNER_APP_MAX_MEMORY?.trim() || "512Mi",
      ephemeralStorage: env.RUNNER_APP_MAX_EPHEMERAL_STORAGE?.trim() || "1Gi",
    },
    baseImageCatalog: loadBaseImageCatalogConfig(env),
    sessionContainerResources: loadSessionContainerResources(env.RUNNER_SESSION_CONTAINERS_RESOURCES),
    sessionStorage: loadSessionStorageConfig(env),
  };
}

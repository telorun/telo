import { loadTeloImageSource, type TeloImageSource } from "@telorun/runner-core/container";
import {
  loadAgentFromObject,
  loadCoreConfig,
  parseBool,
  parsePositiveInt,
  requireStateDirectory,
  RunnerConfigError,
  sessionContainersConfig,
  type RunnerAgent,
  type RunnerCoreConfig,
  type TagFilter,
} from "@telorun/runner-core";

import {
  ConfigSection,
  DEFAULT_CONTAINER_SIZING,
  readConfigFile,
  readContainerSizing,
} from "./config-file.js";
import type { ContainerSizing } from "./limits.js";

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
   *  session images with — the kernel image, and any operator agent image held
   *  in a private registry. */
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
  /** The `apps`, `workspace` and `supervisor` containers' resources (the
   *  session file's `resources`). */
  sessionResources: ContainerSizing;
  /** The operator's co-resident agent (the agent file); none when unset. */
  agent?: RunnerAgent;
  /** The agent's container's resources (the agent file's `resources`): an
   *  operator-curated image, sized separately from anonymous session code. */
  agentResources: ContainerSizing;
  /** Menu of base images a session may pick (advertised as the `image` enum). */
  baseImageCatalog: BaseImageCatalogConfig;
  /** The resources of every pod a session starts through its container engine
   *  (the session file's `containers.resources`). */
  sessionContainerResources: ContainerSizing;
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

const DEFAULT_PORT = 8062;

/** Variables this runner read before sessions became durable workspaces. */
const RETIRED_VARIABLES: Record<string, string> = {
  RUNNER_SELF_URL:
    "it served the bundle fetch, which is gone: a session's files arrive through its workspace. " +
    "Session containers reach the runner through RUNNER_INTERNAL_URL",
  RUNNER_INIT_IMAGE:
    "it ran the bundle fetch, which is gone; a session pod's init container runs RUNNER_SUPERVISOR_IMAGE",
};

/** Variables an earlier k8s runner read, moved into its two configuration
 *  files, each with the file and key that replaced it. */
const MOVED_TO_FILES: ReadonlyArray<{ name: string; file: "session" | "agent"; key: string }> = [
  { name: "RUNNER_MAX_CPU", file: "session", key: "resources.limits.cpu" },
  { name: "RUNNER_MAX_MEMORY", file: "session", key: "resources.limits.memory" },
  { name: "RUNNER_MAX_EPHEMERAL_STORAGE", file: "session", key: "resources.limits.ephemeral-storage" },
  { name: "RUNNER_SESSION_CONTAINERS", file: "session", key: "containers.enabled" },
  { name: "RUNNER_SESSION_CONTAINERS_MAX", file: "session", key: "containers.max" },
  { name: "RUNNER_SESSION_CONTAINERS_RESOURCES", file: "session", key: "containers.resources" },
  { name: "RUNNER_BASE_IMAGE_CATALOG_ENABLED", file: "session", key: "baseImages.enabled" },
  { name: "RUNNER_BASE_IMAGE_REPO", file: "session", key: "baseImages.repository" },
  { name: "RUNNER_BASE_IMAGE_PINNED_ONLY", file: "session", key: "baseImages.pinnedOnly" },
  { name: "RUNNER_BASE_IMAGE_EXCLUDE_SHA", file: "session", key: "baseImages.excludeSha" },
  { name: "RUNNER_BASE_IMAGE_EXCLUDE_PRERELEASE", file: "session", key: "baseImages.excludePrerelease" },
  { name: "RUNNER_BASE_IMAGE_INCLUDE", file: "session", key: "baseImages.include" },
  { name: "RUNNER_BASE_IMAGE_EXCLUDE", file: "session", key: "baseImages.exclude" },
  { name: "RUNNER_BASE_IMAGE_LIMIT", file: "session", key: "baseImages.limit" },
  { name: "RUNNER_BASE_IMAGE_REFRESH_SECONDS", file: "session", key: "baseImages.refreshSeconds" },
  { name: "RUNNER_APP_MAX_CPU", file: "agent", key: "resources.limits.cpu" },
  { name: "RUNNER_APP_MAX_MEMORY", file: "agent", key: "resources.limits.memory" },
  { name: "RUNNER_APP_MAX_EPHEMERAL_STORAGE", file: "agent", key: "resources.limits.ephemeral-storage" },
  { name: "AGENT_IMAGE", file: "agent", key: "image" },
  { name: "AGENT_MODULE_REF", file: "agent", key: "moduleRef" },
  { name: "AGENT_PORT", file: "agent", key: "port" },
  { name: "AGENT_PULL_POLICY", file: "agent", key: "pullPolicy" },
  { name: "AGENT_TOKEN_ENV", file: "agent", key: "tokenEnv" },
  { name: "AGENT_TITLE", file: "agent", key: "title" },
  { name: "AGENT_DESCRIPTION", file: "agent", key: "description" },
  { name: "AGENT_ENV", file: "agent", key: "env" },
];

const FILE_VARIABLES = { session: "SESSION_CONFIG_FILE", agent: "AGENT_CONFIG_FILE" } as const;

/** Refuses to boot with any variable a configuration file replaced, naming
 *  every one at once with the file key to set instead. */
function refuseVariablesMovedToFiles(env: NodeJS.ProcessEnv): void {
  const found = MOVED_TO_FILES.filter(({ name }) => env[name] !== undefined);
  if (found.length === 0) return;
  const lines = found.map(
    ({ name, file, key }) => `  ${name}: set \`${key}\` in the ${file} file (${FILE_VARIABLES[file]}).`,
  );
  const secrets = found.some(({ name }) => name === "AGENT_ENV")
    ? "\nA secret value of the agent's env is listed by name in `secretEnv` and read from AGENT_SECRET_<NAME>."
    : "";
  throw new RunnerConfigError(
    `this runner reads these settings from its configuration files, so the ${found.length === 1 ? "variable" : "variables"} ` +
      `must be unset:\n${lines.join("\n")}${secrets}`,
  );
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

/** The session file (`SESSION_CONFIG_FILE`): `resources`, `containers` and
 *  `baseImages`, every key defaulting when the file or the key is absent. */
function loadSessionFile(env: NodeJS.ProcessEnv): {
  resources: ContainerSizing;
  containers: { enabled: boolean; max: number; resources: ContainerSizing; enabledBy: string };
  baseImageCatalog: BaseImageCatalogConfig;
} {
  const read = readConfigFile(env, FILE_VARIABLES.session);
  const root = ConfigSection.root(read?.file ?? FILE_VARIABLES.session, read?.value, [
    "resources",
    "containers",
    "baseImages",
  ]);
  const containers = root.section("containers", ["enabled", "max", "resources"]);
  return {
    resources: readContainerSizing(root, "resources"),
    containers: {
      enabled: containers.boolean("enabled", false),
      max: containers.positiveInt("max", 4),
      resources: readContainerSizing(containers, "resources"),
      enabledBy: containers.name("enabled"),
    },
    baseImageCatalog: readBaseImageCatalog(root),
  };
}

function readBaseImageCatalog(root: ConfigSection): BaseImageCatalogConfig {
  const images = root.section("baseImages", [
    "enabled",
    "repository",
    "pinnedOnly",
    "excludeSha",
    "excludePrerelease",
    "include",
    "exclude",
    "limit",
    "refreshSeconds",
  ]);
  const pattern = (key: string): RegExp[] | undefined => {
    const source = images.string(key);
    if (source === undefined) return undefined;
    try {
      return [new RegExp(source)];
    } catch (err) {
      throw new RunnerConfigError(`${images.name(key)} is not a valid regular expression: ${(err as Error).message}`);
    }
  };
  return {
    enabled: images.boolean("enabled", true),
    repository: images.string("repository") ?? "telorun/node",
    filter: {
      pinnedOnly: images.boolean("pinnedOnly", true),
      excludeSha: images.boolean("excludeSha", true),
      excludePrerelease: images.boolean("excludePrerelease", true),
      include: pattern("include"),
      exclude: pattern("exclude"),
    },
    limit: images.positiveInt("limit", 20),
    refreshIntervalMs: images.positiveInt("refreshSeconds", 3600) * 1000,
  };
}

/** The agent file (`AGENT_CONFIG_FILE`): the agent's settings, read by
 *  runner-core, and the `resources` of its container, read here. */
function loadAgentFile(env: NodeJS.ProcessEnv): { agent?: RunnerAgent; resources: ContainerSizing } {
  const read = readConfigFile(env, FILE_VARIABLES.agent);
  if (!read) return { resources: DEFAULT_CONTAINER_SIZING };
  const { file, value } = read;
  if (value !== null && value !== undefined && (typeof value !== "object" || Array.isArray(value))) {
    throw new RunnerConfigError(`${file} must hold a map of the agent's settings.`);
  }
  const { resources, ...settings } = (value ?? {}) as Record<string, unknown>;
  const agent = loadAgentFromObject(settings, { file, env });
  // A pod cannot read a path on the operator's machine, so a host path is refused
  // here rather than failing every session that runs the agent.
  if (agent?.source.kind === "module" && !agent.source.ref.startsWith("oci://")) {
    throw new RunnerConfigError(
      `\`moduleRef\` in ${file} is a host path, which a Kubernetes pod cannot read — use an oci:// reference.`,
    );
  }
  const root = ConfigSection.root(file, { resources }, ["resources"]);
  return { ...(agent ? { agent } : {}), resources: readContainerSizing(root, "resources") };
}

export function loadK8sRunnerConfig(env: NodeJS.ProcessEnv): K8sRunnerConfig {
  for (const [name, why] of Object.entries(RETIRED_VARIABLES)) {
    if (env[name] !== undefined) {
      throw new RunnerConfigError(`${name} is no longer read and must be unset: ${why}.`);
    }
  }
  refuseVariablesMovedToFiles(env);
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
  const session = loadSessionFile(env);
  const agentFile = loadAgentFile(env);

  return {
    ...core,
    sessionContainers: sessionContainersConfig(session.containers, env, session.containers.enabledBy),
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
    sessionResources: session.resources,
    ...(agentFile.agent ? { agent: agentFile.agent } : {}),
    agentResources: agentFile.resources,
    baseImageCatalog: session.baseImageCatalog,
    sessionContainerResources: session.containers.resources,
    sessionStorage: loadSessionStorageConfig(env),
  };
}

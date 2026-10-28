import {
  BaseImageCatalog,
  buildServer as coreBuildServer,
  loadAgentFromEnv,
  loadTermsFromEnv,
  openSessionStore,
  type RunnerBackend,
  type ServerHandle,
  type SessionConfig,
  type SessionStore,
} from "@telorun/runner-core";
import {
  optionalContainerConfig,
  validateOptionalContainerConfig,
} from "@telorun/runner-core/container";

import { pino } from "pino";

import packageJson from "../package.json" with { type: "json" };
import { kubernetesRunnerCapabilities } from "./capabilities.js";
import { loadK8sRunnerConfig, RunnerConfigError, type K8sRunnerConfig } from "./config.js";
import { createKubernetesBackend } from "./k8s/backend.js";
import { createKubeClient } from "./k8s/client.js";
import { createSessionRouter } from "./k8s/routing/index.js";

const VERSION: string = packageJson.version;

export interface ServerDeps {
  backend: RunnerBackend;
  config: K8sRunnerConfig;
  /** Opened before the server: core loads and adopts every stored session
   *  while building it. */
  store: SessionStore;
  /** Base-image catalog whose resolved list becomes the advertised `image`
   *  enum + the server-side allowlist. Omitted → `image` locks to defaultImage. */
  catalog?: BaseImageCatalog;
}

export async function buildServer(deps: ServerDeps): Promise<ServerHandle> {
  const { catalog } = deps;
  // Load terms once; the capabilities getter is re-resolved per request so a
  // refreshed catalog (new tags) shows up without restarting the runner.
  const terms = loadTermsFromEnv(process.env);
  const agent = loadAgentFromEnv(process.env);
  // A pod cannot read a path on the operator's machine, so a host path is refused
  // here rather than failing every session that runs the agent.
  if (agent?.source.kind === "module" && !agent.source.ref.startsWith("oci://")) {
    throw new RunnerConfigError(
      "AGENT_MODULE_REF is a host path, which a Kubernetes pod cannot read — use an oci:// reference.",
    );
  }

  const handle = await coreBuildServer({
    backend: deps.backend,
    config: deps.config,
    version: VERSION,
    capabilities: () =>
      kubernetesRunnerCapabilities({
        displayName: deps.config.displayName,
        description: deps.config.description,
        defaultImage: deps.config.defaultImage,
        terms,
        imageEnum: catalog?.current(),
        agents: agent ? [agent.name] : [],
      }),
    // The operator's co-resident agent (AGENT_*; none when unset).
    agent,
    store: deps.store,
    // The session config is opaque to core, so this runner enforces its own
    // shape — UNCONDITIONALLY, not only when a catalog is configured: the
    // catalog answers "which image", while the shape check answers "is this a
    // config at all", and tying the second to the first is what let a
    // catalog-less runner accept an unusable one. An absent image is not a
    // violation; this runner supplies its own default, which is the operator's
    // choice rather than the caller's.
    validateConfig: (sessionConfig: SessionConfig, request): string | undefined => {
      const invalid = validateOptionalContainerConfig(sessionConfig, request);
      if (invalid) return invalid;
      if (!catalog) return undefined;
      const { image } = optionalContainerConfig(sessionConfig);
      if (image === undefined || catalog.isAllowed(image)) return undefined;
      return (
        `base image '${image}' is not offered by this runner. ` +
        `Allowed images: ${catalog.current().join(", ")}`
      );
    },
  });
  return handle;
}

async function main(): Promise<void> {
  let config: K8sRunnerConfig;
  try {
    config = loadK8sRunnerConfig(process.env);
  } catch (err) {
    if (err instanceof RunnerConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const kube = createKubeClient();
  // What runs before the server exists — the session store, adoption and the
  // orphan sweep — logs here, to the same stdout as the server's own log.
  const bootLog = pino({ level: config.logLevel });

  // Resolve the routing layer ONCE, here: an unroutable configuration must fail
  // the runner rather than every session it would otherwise accept, publish
  // routes for, and leave 404-ing with nothing reported.
  let routing: Awaited<ReturnType<typeof createSessionRouter>>;
  try {
    routing = await createSessionRouter(kube, config);
  } catch (err) {
    if (err instanceof RunnerConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const catalog = config.baseImageCatalog.enabled
    ? new BaseImageCatalog({
        repository: config.baseImageCatalog.repository,
        defaultRef: config.defaultImage,
        filter: config.baseImageCatalog.filter,
        limit: config.baseImageCatalog.limit,
        refreshIntervalMs: config.baseImageCatalog.refreshIntervalMs,
      })
    : undefined;

  let store: SessionStore;
  try {
    store = await openSessionStore(config.sessionStore, { log: bootLog });
  } catch (err) {
    bootLog.error({ err }, "could not open the session store");
    process.exit(1);
  }

  const backend = createKubernetesBackend({ kube, config, router: routing.router, log: bootLog });

  // Builds the server and, inside it, adopts every running session's pod and
  // runs the orphan sweep, before the runner listens.
  let app: ServerHandle["app"];
  try {
    ({ app } = await buildServer({ backend, config, store, catalog }));
  } catch (err) {
    bootLog.error({ err }, "the runner could not start");
    await store.close();
    process.exit(1);
  }

  // Say which layer carries session traffic. An operator reading "logs-only" here
  // is the difference between a misconfiguration found at boot and one found as a
  // 404 on a URL the editor handed a user.
  if (routing.resolved.layer === "none") {
    app.log.warn({ reason: routing.resolved.reason }, "session routing disabled (logs-only)");
  } else {
    app.log.info(
      {
        layer: routing.resolved.layer,
        ...(routing.resolved.layer === "gateway"
          ? {
              apiVersion: routing.resolved.apiVersion,
              gateway: `${config.sessionRouting.gateway?.namespace}/${config.sessionRouting.gateway?.name}`,
            }
          : { ingressClass: config.sessionRouting.ingressClassName ?? "(cluster default)" }),
        baseDomain: config.sessionRouting.baseDomain,
      },
      "session routing resolved",
    );
  }

  // Populate the catalog before serving so the first /v1/capabilities carries the
  // full menu; a fetch failure degrades to the default image (surfaced, not
  // swallowed) and the periodic refresh retries.
  if (catalog) {
    await catalog
      .refresh()
      .catch((err) =>
        app.log.warn({ err }, "initial base-image catalog refresh failed; serving default image only"),
      );
    catalog.start((err) => app.log.warn({ err }, "base-image catalog refresh failed"));
  }

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    catalog?.stop();
    // Detaches every workload: session pods outlive the runner and are adopted
    // by the next one.
    await app.close();
    await store.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  void main();
}

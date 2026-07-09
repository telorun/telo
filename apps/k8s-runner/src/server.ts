import {
  BaseImageCatalog,
  buildServer as coreBuildServer,
  loadResolvedApps,
  loadTermsFromEnv,
  stopAllSessions,
  type RunnerBackend,
  type ServerHandle,
  type SessionConfig,
} from "@telorun/runner-core";

import packageJson from "../package.json" with { type: "json" };
import { BundleStore } from "./bundle-store.js";
import { kubernetesRunnerCapabilities } from "./capabilities.js";
import { loadK8sRunnerConfig, RunnerConfigError, type K8sRunnerConfig } from "./config.js";
import { createKubernetesBackend } from "./k8s/backend.js";
import { createKubeClient } from "./k8s/client.js";

const VERSION: string = packageJson.version;

export interface ServerDeps {
  backend: RunnerBackend;
  config: K8sRunnerConfig;
  bundleStore: BundleStore;
  /** Base-image catalog whose resolved list becomes the advertised `image`
   *  enum + the server-side allowlist. Omitted → `image` locks to defaultImage. */
  catalog?: BaseImageCatalog;
}

export async function buildServer(deps: ServerDeps): Promise<ServerHandle> {
  const { catalog } = deps;
  // Load terms once; the capabilities getter is re-resolved per request so a
  // refreshed catalog (new tags) shows up without restarting the runner.
  const terms = loadTermsFromEnv(process.env);

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
      }),
    defaultRegistryUrl: process.env.TELO_REGISTRY_URL,
    // Operator-predefined apps (RUNNER_APPS; none when unset). Advertised on
    // /v1/capabilities; app sessions run the catalog image directly (no build).
    apps: loadResolvedApps(process.env),
    validateConfig: catalog
      ? (sessionConfig: SessionConfig): string | undefined =>
          catalog.isAllowed(sessionConfig.image)
            ? undefined
            : `base image '${sessionConfig.image}' is not offered by this runner. ` +
              `Allowed images: ${catalog.current().join(", ")}`
      : undefined,
  });
  // Mount the internal, tokenized fetch route on the same app so a build Job's
  // initContainer can pull the build-context tarball (bundle + Dockerfile).
  deps.bundleStore.registerRoute(handle.app);
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
  const bundleStore = new BundleStore(config.selfUrl);
  const backend = createKubernetesBackend({ kube, config, bundleStore });

  const catalog = config.baseImageCatalog.enabled
    ? new BaseImageCatalog({
        repository: config.baseImageCatalog.repository,
        defaultRef: config.defaultImage,
        filter: config.baseImageCatalog.filter,
        limit: config.baseImageCatalog.limit,
        refreshIntervalMs: config.baseImageCatalog.refreshIntervalMs,
      })
    : undefined;

  const { app, registry } = await buildServer({ backend, config, bundleStore, catalog });

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

  // Reap pods orphaned by a prior runner process (in-memory registry).
  if (backend.reapOrphans) {
    await backend.reapOrphans().catch((err) => app.log.warn({ err }, "orphan reap failed"));
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
    for (const entry of registry.list()) entry.userStopped = true;
    await app.close();
    await stopAllSessions(registry, app.log);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  void main();
}

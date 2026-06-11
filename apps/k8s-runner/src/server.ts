import {
  buildServer as coreBuildServer,
  stopAllSessions,
  type RunnerBackend,
  type ServerHandle,
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
}

export async function buildServer(deps: ServerDeps): Promise<ServerHandle> {
  const handle = await coreBuildServer({
    backend: deps.backend,
    config: deps.config,
    version: VERSION,
    capabilities: kubernetesRunnerCapabilities(deps.config.defaultImage),
    defaultRegistryUrl: process.env.TELO_REGISTRY_URL,
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

  const { app, registry } = await buildServer({ backend, config, bundleStore });

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

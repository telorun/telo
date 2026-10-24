import {
  buildServer as coreBuildServer,
  coResidentAgentNames,
  loadResolvedApps,
  loadTermsFromEnv,
  openSessionStore,
  type RunnerBackend,
  type ServerHandle,
  type SessionStore,
} from "@telorun/runner-core";
import { validateContainerConfig } from "@telorun/runner-core/container";
import { pino } from "pino";

import packageJson from "../package.json" with { type: "json" };
import { dockerRunnerCapabilities } from "./capabilities.js";
import { loadRunnerConfig, RunnerConfigError, type RunnerConfig } from "./config.js";
import { createDockerBackend } from "./docker/backend.js";
import { createDockerClient, refuseDaemonWithoutSubpath } from "./docker/client.js";
import type { SessionDockerClient } from "./docker/docker-api.js";
import type { EngineDockerClient } from "./docker/session-container-engine.js";
import { deliverSupervisor, IMAGE_SUPERVISOR_PATH } from "./docker/supervisor-delivery.js";
import { loadRunnerEnvFiles } from "./load-env.js";

const VERSION: string = packageJson.version;

export interface ServerDeps {
  backend: RunnerBackend;
  config: RunnerConfig;
  /** Opened before the server: core loads and adopts every stored session
   *  while building it. */
  store: SessionStore;
}

export async function buildServer(deps: ServerDeps): Promise<ServerHandle> {
  const apps = loadResolvedApps(process.env);
  return coreBuildServer({
    backend: deps.backend,
    config: deps.config,
    version: VERSION,
    // Terms are opt-in via RUNNER_TERMS_* — a local docker-runner ships with
    // none (no gate); an operator can still require them by setting the env.
    capabilities: {
      // Only entries that declare a port: the session route refuses an agent
      // without one, and advertising what will be rejected is what makes the
      // editor attach an agent to every session and every session fail.
      ...dockerRunnerCapabilities({ agents: coResidentAgentNames(apps) }),
      terms: loadTermsFromEnv(process.env),
    },
    // The operator's agent catalog (RUNNER_APPS; none when unset).
    apps,
    store: deps.store,
    // Core carries the session config as an opaque bag, so the runner that
    // needs an image is the one that insists on it — a 400 naming the field,
    // rather than a start failure arriving on the event stream.
    validateConfig: validateContainerConfig,
  });
}

/** The daemon objects every session needs, which the runner cannot create on
 *  the operator's behalf. Undefined when both exist. */
async function missingDaemonObject(docker: SessionDockerClient, config: RunnerConfig): Promise<string | undefined> {
  try {
    await docker.getVolume(config.bundleVolume).inspect();
  } catch {
    return (
      `BUNDLE_VOLUME '${config.bundleVolume}' does not exist on the daemon. ` +
      `Run: docker volume create ${config.bundleVolume}`
    );
  }
  try {
    await docker.getNetwork(config.childNetwork).inspect();
  } catch {
    return (
      `RUNNER_CHILD_NETWORK '${config.childNetwork}' does not exist on the daemon. ` +
      `Create the network or set RUNNER_CHILD_NETWORK to an existing one.`
    );
  }
  return undefined;
}

async function main(): Promise<void> {
  // Load `.env` / `.env.local` before reading config so secret-bearing config
  // (e.g. the RUNNER_APPS catalog) can live in a file.
  loadRunnerEnvFiles();

  let config: RunnerConfig;
  const docker = createDockerClient() as unknown as SessionDockerClient & EngineDockerClient;
  try {
    config = loadRunnerConfig(process.env);
    await refuseDaemonWithoutSubpath(docker);
  } catch (err) {
    if (err instanceof RunnerConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  // What runs before the server exists — the session store, adoption and the
  // orphan sweep — logs here, to the same stdout as the server's own log.
  const bootLog = pino({ level: config.logLevel });

  const missing = await missingDaemonObject(docker, config);
  if (missing) {
    bootLog.error(missing);
    process.exit(1);
  }

  let supervisor: Awaited<ReturnType<typeof deliverSupervisor>>;
  try {
    supervisor = await deliverSupervisor(IMAGE_SUPERVISOR_PATH, config.bundleRoot);
  } catch (err) {
    bootLog.error({ err }, "could not write the session supervisor to the bundle volume");
    process.exit(1);
  }

  let store: SessionStore;
  try {
    store = await openSessionStore(config.sessionStore, { log: bootLog });
  } catch (err) {
    bootLog.error({ err }, "could not open the session store");
    process.exit(1);
  }

  const backend = createDockerBackend({
    docker,
    bundleRoot: config.bundleRoot,
    bundleVolume: config.bundleVolume,
    childNetwork: config.childNetwork,
    publicBaseUrl: config.publicBaseUrl,
    teloImages: config.teloImages,
    workspaceImage: config.workspaceImage,
    supervisor,
    log: bootLog,
  });

  // Builds the server and, inside it, adopts every running session's containers
  // and runs the orphan sweep, before the runner listens.
  let app: ServerHandle["app"];
  try {
    ({ app } = await buildServer({ backend, config, store }));
  } catch (err) {
    bootLog.error({ err }, "the runner could not start");
    await store.close();
    process.exit(1);
  }

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    // Detaches every workload: session containers outlive the runner and are
    // adopted by the next one.
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

import type { FastifyBaseLogger } from "fastify";
import {
  buildServer as coreBuildServer,
  loadTermsFromEnv,
  stopAllSessions,
  type ServerHandle,
  type SessionRegistry,
} from "@telorun/runner-core";

import packageJson from "../package.json" with { type: "json" };
import { dockerRunnerCapabilities } from "./capabilities.js";
import { loadRunnerConfig, RunnerConfigError, type RunnerConfig } from "./config.js";
import { createDockerClient, type DockerClient } from "./docker/client.js";
import { createDockerBackend } from "./docker/backend.js";
import type { SessionDockerClient } from "./docker/run-session.js";
import { sweepOrphanBundles } from "./session/bundle-sweep.js";

const VERSION: string = packageJson.version;

export interface ServerDeps {
  docker: DockerClient & SessionDockerClient;
  runnerConfig: RunnerConfig;
  registry?: SessionRegistry;
}

export async function buildServer(deps: ServerDeps): Promise<ServerHandle> {
  const backend = createDockerBackend({
    docker: deps.docker,
    bundleRoot: deps.runnerConfig.bundleRoot,
    bundleVolume: deps.runnerConfig.bundleVolume,
    childNetwork: deps.runnerConfig.childNetwork,
  });

  return coreBuildServer({
    backend,
    config: deps.runnerConfig,
    version: VERSION,
    // Terms are opt-in via RUNNER_TERMS_* — a local docker-runner ships with
    // none (no gate); an operator can still require them by setting the env.
    capabilities: { ...dockerRunnerCapabilities, terms: loadTermsFromEnv(process.env) },
    defaultRegistryUrl: process.env.TELO_REGISTRY_URL,
    registry: deps.registry,
  });
}

export async function verifyBootState(
  docker: DockerClient,
  runnerConfig: RunnerConfig,
  log: Pick<FastifyBaseLogger, "warn" | "error" | "info">,
): Promise<"ok" | "daemon-unreachable" | "volume-missing" | "network-missing"> {
  try {
    await docker.ping();
  } catch (err) {
    log.warn(
      { err },
      "docker daemon not reachable at boot; /v1/probe will surface this once the editor connects",
    );
    return "daemon-unreachable";
  }

  try {
    await docker.getVolume(runnerConfig.bundleVolume).inspect();
  } catch {
    log.error(
      `BUNDLE_VOLUME '${runnerConfig.bundleVolume}' does not exist on the daemon. ` +
        `Run: docker volume create ${runnerConfig.bundleVolume}`,
    );
    return "volume-missing";
  }

  try {
    await docker.getNetwork(runnerConfig.childNetwork).inspect();
  } catch {
    log.error(
      `RUNNER_CHILD_NETWORK '${runnerConfig.childNetwork}' does not exist on the daemon. ` +
        `Create the network or set RUNNER_CHILD_NETWORK to an existing one.`,
    );
    return "network-missing";
  }

  log.info(
    { bundleVolume: runnerConfig.bundleVolume, childNetwork: runnerConfig.childNetwork },
    "boot checks passed",
  );
  return "ok";
}

async function main(): Promise<void> {
  let runnerConfig: RunnerConfig;
  try {
    runnerConfig = loadRunnerConfig(process.env);
  } catch (err) {
    if (err instanceof RunnerConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const docker = createDockerClient() as DockerClient & SessionDockerClient;
  const { app, registry } = await buildServer({ docker, runnerConfig });

  const bootState = await verifyBootState(docker, runnerConfig, app.log);
  if (bootState === "volume-missing" || bootState === "network-missing") {
    process.exit(1);
  }

  if (bootState === "ok") {
    await sweepOrphanBundles(runnerConfig.bundleRoot, docker, app.log);
  }

  try {
    await app.listen({ port: runnerConfig.port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    // Mark every live entry userStopped first so an in-flight POST /v1/sessions
    // (e.g. mid-pull) kills its workload as soon as it materializes; then drain
    // in-flight requests; then mop up sessions wired before shutdown started.
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

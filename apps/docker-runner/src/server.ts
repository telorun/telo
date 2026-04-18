import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";

import { loadRunnerConfig, RunnerConfigError, type RunnerConfig } from "./config.js";
import { createDockerClient, type DockerClient } from "./docker/client.js";
import { stopContainer, type SessionDockerClient } from "./docker/run-session.js";
import { healthRoute } from "./routes/health.js";
import { probeRoute } from "./routes/probe.js";
import { sessionsRoute } from "./routes/sessions.js";
import { sweepOrphanBundles } from "./session/bundle-sweep.js";
import { SessionRegistry } from "./session/registry.js";

export interface ServerDeps {
  docker: DockerClient & SessionDockerClient;
  runnerConfig: RunnerConfig;
  registry?: SessionRegistry;
}

export interface ServerHandle {
  app: FastifyInstance;
  registry: SessionRegistry;
}

export async function buildServer(deps: ServerDeps): Promise<ServerHandle> {
  const app = Fastify({
    logger: {
      level: deps.runnerConfig.logLevel,
    },
  });

  // CORS: SSE and fetch from the editor's browser origin are cross-origin by
  // default. The runner already sits behind no auth — a tab that can reach the
  // port can drive it — so default to `*` and let operators narrow via
  // RUNNER_CORS_ORIGINS when they have a specific origin in mind.
  await app.register(cors, {
    origin: deps.runnerConfig.corsOrigins,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  });

  const registry =
    deps.registry ??
    new SessionRegistry({
      maxSessions: deps.runnerConfig.maxSessions,
      exitTtlMs: deps.runnerConfig.exitTtlMs,
      replayBufferBytes: deps.runnerConfig.replayBufferBytes,
    });

  await app.register(healthRoute);
  await app.register(
    probeRoute({
      docker: deps.docker,
      runnerConfig: deps.runnerConfig,
    }),
  );
  await app.register(
    sessionsRoute({
      docker: deps.docker,
      registry,
      runnerConfig: deps.runnerConfig,
    }),
  );

  return { app, registry };
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

async function killLiveSessions(
  registry: SessionRegistry,
  log: Pick<FastifyBaseLogger, "info" | "warn">,
): Promise<void> {
  const live = registry.list().filter((e) => e.container !== null && e.exitedAt === null);
  if (live.length === 0) return;
  log.info({ count: live.length }, "stopping live sessions before shutdown");
  await Promise.all(
    live.map(async (entry) => {
      if (!entry.container) return;
      entry.userStopped = true;
      try {
        await stopContainer(entry.container);
      } catch (err) {
        log.warn({ err, sessionId: entry.sessionId }, "failed to stop session during shutdown");
      }
    }),
  );
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
    // Order matters. Three phases, because an in-flight POST /v1/sessions
    // (e.g. mid-pull) has a registry entry but no container yet; naive
    // killLiveSessions would skip it, app.close() would then finish the
    // spawn, and the freshly-created container would leak past process exit.
    //
    //   1. Mark every live entry as userStopped. Entries mid-spawn trigger
    //      the pre-start race fix in startSession and kill their container
    //      as soon as it materializes.
    //   2. app.close() drains in-flight requests (including the spawns from
    //      step 1) and stops accepting new ones.
    //   3. killLiveSessions mops up sessions that were already wired before
    //      shutdown started.
    for (const entry of registry.list()) entry.userStopped = true;
    await app.close();
    await killLiveSessions(registry, app.log);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  void main();
}

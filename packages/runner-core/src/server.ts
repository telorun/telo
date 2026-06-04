import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";

import type { RunnerBackend } from "./backend.js";
import type { RunnerCoreConfig } from "./config.js";
import { healthRoute } from "./routes/health.js";
import { ioRoute } from "./routes/io.js";
import { probeRoute } from "./routes/probe.js";
import { sessionsRoute } from "./routes/sessions.js";
import { SessionRegistry } from "./session/registry.js";

export interface ServerDeps {
  backend: RunnerBackend;
  config: RunnerCoreConfig;
  /** The concrete runner's package version, surfaced on /v1/health. */
  version: string;
  /** Runner's default registry URL, passed to workloads as TELO_REGISTRY_URL. */
  defaultRegistryUrl?: string;
  registry?: SessionRegistry;
}

export interface ServerHandle {
  app: FastifyInstance;
  registry: SessionRegistry;
}

export async function buildServer(deps: ServerDeps): Promise<ServerHandle> {
  const app = Fastify({
    logger: { level: deps.config.logLevel },
  });

  // CORS: SSE and fetch from the editor's browser origin are cross-origin by
  // default. A runner with no auth is driven by whoever can reach the port, so
  // default to `*` and let operators narrow via RUNNER_CORS_ORIGINS.
  await app.register(cors, {
    origin: deps.config.corsOrigins,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  });

  await app.register(websocket);

  const registry =
    deps.registry ??
    new SessionRegistry({
      maxSessions: deps.config.maxSessions,
      exitTtlMs: deps.config.exitTtlMs,
      replayBufferBytes: deps.config.replayBufferBytes,
    });

  await app.register(healthRoute(deps.version));
  await app.register(probeRoute({ backend: deps.backend }));
  await app.register(
    sessionsRoute({
      backend: deps.backend,
      registry,
      corsOrigins: deps.config.corsOrigins,
      defaultRegistryUrl: deps.defaultRegistryUrl,
    }),
  );
  await app.register(ioRoute({ registry, corsOrigins: deps.config.corsOrigins }));

  return { app, registry };
}

/**
 * Stop every live session. Used by graceful shutdown — marks each entry
 * userStopped and stops its backend workload so nothing leaks past process
 * exit. Backend-neutral: it only touches the abstract `BackendSession`.
 */
export async function stopAllSessions(
  registry: SessionRegistry,
  log: Pick<FastifyBaseLogger, "info" | "warn">,
): Promise<void> {
  const live = registry.list().filter((e) => e.session !== null && e.exitedAt === null);
  if (live.length === 0) return;
  log.info({ count: live.length }, "stopping live sessions before shutdown");
  await Promise.all(
    live.map(async (entry) => {
      entry.userStopped = true;
      try {
        await entry.session?.stop();
      } catch (err) {
        log.warn({ err, sessionId: entry.sessionId }, "failed to stop session during shutdown");
      }
    }),
  );
}

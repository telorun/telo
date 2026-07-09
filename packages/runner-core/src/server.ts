import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";

import type { RunnerBackend } from "./backend.js";
import type { ResolvedRunnerApp, RunnerCoreConfig } from "./config.js";
import type { RunnerAppDescriptor, RunnerCapabilities, SessionConfig } from "./contract.js";
import { capabilitiesRoute } from "./routes/capabilities.js";
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
  /** The runner's self-description + editable config schema, served on
   *  /v1/capabilities so the editor renders a generic runner config form. A
   *  getter is re-resolved per request — use it when the config surface changes
   *  at runtime (e.g. a base-image catalog refreshed from a registry). */
  capabilities: RunnerCapabilities | (() => RunnerCapabilities);
  /** Runner's default registry URL, passed to workloads as TELO_REGISTRY_URL. */
  defaultRegistryUrl?: string;
  /** Backend config gate, enforced on `POST /v1/sessions` before the workload
   *  starts (e.g. an `image` allowlist). Rejects with `400 invalid_config`.
   *  Not consulted for app sessions — their image comes from `apps`. */
  validateConfig?: (config: SessionConfig) => string | undefined;
  /** Operator-predefined applications launchable by name (usually
   *  `loadResolvedApps(process.env)`). Advertised on /v1/capabilities as
   *  `apps` descriptors; the session route resolves and gates against it. */
  apps?: Record<string, ResolvedRunnerApp>;
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

  // The app catalog is injected into the served capabilities document here, so
  // what /v1/capabilities advertises and what the session route accepts can
  // never drift — both come from `deps.apps`.
  const appDescriptors: RunnerAppDescriptor[] = Object.values(deps.apps ?? {}).map(
    ({ name, title, description }) => ({ name, title, description }),
  );
  const withApps = (caps: RunnerCapabilities): RunnerCapabilities =>
    appDescriptors.length > 0 ? { ...caps, apps: appDescriptors } : caps;
  const capabilitiesGetter =
    typeof deps.capabilities === "function"
      ? () => withApps((deps.capabilities as () => RunnerCapabilities)())
      : withApps(deps.capabilities);

  // Terms are stable across the process — resolve the capabilities once for them
  // even when `capabilities` is a getter (the route still re-resolves per request).
  const capabilitiesValue =
    typeof capabilitiesGetter === "function" ? capabilitiesGetter() : capabilitiesGetter;

  await app.register(healthRoute(deps.version));
  await app.register(capabilitiesRoute(capabilitiesGetter));
  await app.register(probeRoute({ backend: deps.backend }));
  await app.register(
    sessionsRoute({
      backend: deps.backend,
      registry,
      corsOrigins: deps.config.corsOrigins,
      defaultRegistryUrl: deps.defaultRegistryUrl,
      validateConfig: deps.validateConfig,
      // The capabilities document is the single source of the runner's terms;
      // the session route enforces what /v1/capabilities advertises.
      terms: capabilitiesValue.terms,
      apps: deps.apps,
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

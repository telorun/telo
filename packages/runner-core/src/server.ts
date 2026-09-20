import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";

import type { RunnerBackend } from "./backend.js";
import type { ResolvedRunnerApp, RunnerCoreConfig } from "./config.js";
import type { RunnerAppDescriptor, RunnerCapabilities, SessionConfig } from "./contract.js";
import { appsRoute } from "./routes/apps.js";
import { capabilitiesRoute } from "./routes/capabilities.js";
import { healthRoute } from "./routes/health.js";
import { ioRoute } from "./routes/io.js";
import { probeRoute } from "./routes/probe.js";
import { sessionsRoute } from "./routes/sessions.js";
import { SessionRegistry } from "./session/registry.js";
import { WatchSupervisor } from "./session/watch-supervisor.js";

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
  /** Backend config gate, enforced on `POST /v1/sessions` before the workload
   *  starts (e.g. an `image` allowlist). Rejects with `400 invalid_config`.
   *  Not consulted for app sessions — their image comes from `apps`. */
  validateConfig?: (config: SessionConfig) => string | undefined;
  /** Operator-predefined applications launchable by name (usually
   *  `loadResolvedApps(process.env)`). Advertised on /v1/capabilities as
   *  `apps` descriptors; sessions of them are created via
   *  `POST /v1/apps/:name/sessions`. */
  apps?: Record<string, ResolvedRunnerApp>;
  registry?: SessionRegistry;
  /** Where the runner's own log goes. Defaults to pino's own destination
   *  (stdout), which is right for a container whose stdout IS its log — and
   *  wrong for a runner hosted inside a CLI, where stdout is the machine
   *  surface and a request line written onto it is corruption rather than
   *  noise. */
  logStream?: NodeJS.WritableStream;
}

export interface ServerHandle {
  app: FastifyInstance;
  registry: SessionRegistry;
}

export async function buildServer(deps: ServerDeps): Promise<ServerHandle> {
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
  });

  // CORS: SSE and fetch from the editor's browser origin are cross-origin by
  // default. A runner with no auth is driven by whoever can reach the port, so
  // default to `*` and let operators narrow via RUNNER_CORS_ORIGINS.
  await app.register(cors, {
    origin: deps.config.corsOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  // **A narrowed origin list is enforced on the server, not just advertised.**
  // CORS is a browser's rule about what it hands back to a page: the request
  // still arrives, and a client that ignores the response headers is unaffected.
  // For a runner that starts workloads for whoever can reach it, the refusal has
  // to be the runner's own. The byte channel already refuses on its own terms
  // (`4403`, an application close code a browser can actually read, where an
  // HTTP 403 on a failed upgrade is invisible), so upgrades are left to it.
  //
  // Registered BEFORE the routes, because Fastify binds hooks at route
  // registration. A request with NO `Origin` is left alone here: every CLI,
  // script and health check sends none, and what bounds those is the transport
  // (a loopback bind, a cluster network). The upgrade path makes the opposite
  // call for the opposite reason — a browser always sends one there.
  const allowedOrigins = deps.config.corsOrigins;
  if (allowedOrigins !== "*") {
    const allowed = new Set(allowedOrigins);
    app.addHook("onRequest", async (req, reply) => {
      if (req.headers.upgrade?.toLowerCase() === "websocket") return;
      const origin = req.headers.origin;
      if (typeof origin === "string" && !allowed.has(origin)) {
        await reply.code(403).send({
          error: "origin_not_allowed",
          message:
            `origin '${origin}' is not allowed by this runner` +
            (allowed.size > 0 ? ` — it serves ${[...allowed].join(", ")}` : ""),
        });
      }
    });
  }

  await app.register(websocket);

  const registry =
    deps.registry ??
    new SessionRegistry({
      maxSessions: deps.config.maxSessions,
      exitTtlMs: deps.config.exitTtlMs,
      replayBufferBytes: deps.config.replayBufferBytes,
      suspendedTtlMs: deps.config.watch.suspendedTtlMs,
    });

  // The checkpoint timer and the idle reaper. Started unconditionally: it walks
  // watch sessions only, and with watch disabled there are none.
  const supervisor = new WatchSupervisor({
    registry,
    idleMs: deps.config.watch.idleMs,
    checkpointMs: deps.config.watch.checkpointMs,
    log: app.log,
  });
  supervisor.start();
  app.addHook("onClose", async () => supervisor.stop());

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
      validateConfig: deps.validateConfig,
      // The capabilities document is the single source of the runner's terms;
      // every session-creating route enforces what /v1/capabilities advertises.
      terms: capabilitiesValue.terms,
      // A co-resident agent IS an operator-predefined application — one that
      // happens to share a pod — so it resolves against the same catalog.
      apps: deps.apps,
      watch: {
        enabled: deps.config.watch.enabled,
        maxSessions: deps.config.watch.maxSessions,
        reloadLimitPerMinute: deps.config.watch.reloadLimitPerMinute,
      },
      // Read from the advertised capabilities for the same reason terms are:
      // the document a client reads and the rule the route enforces have to be
      // one statement. A runner advertising `["streams"]` refuses an explicit
      // `io: "tty"` here, rather than handing back a session that says it has a
      // terminal and does not.
      io: capabilitiesValue.features.io,
    }),
  );
  await app.register(
    appsRoute({
      backend: deps.backend,
      registry,
      terms: capabilitiesValue.terms,
      apps: deps.apps,
      io: capabilitiesValue.features.io,
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

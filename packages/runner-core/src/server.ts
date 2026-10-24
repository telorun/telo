import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";

import type { RunnerBackend } from "./backend.js";
import { RunnerConfigError, type ResolvedRunnerApp, type RunnerCoreConfig } from "./config.js";
import type { RunnerCapabilities } from "./contract.js";
import { capabilitiesRoute } from "./routes/capabilities.js";
import { healthRoute } from "./routes/health.js";
import { ioRoute } from "./routes/io.js";
import { probeRoute } from "./routes/probe.js";
import { engineRoute } from "./routes/engine.js";
import { IdentityVerifier } from "./identity/identity-verifier.js";
import {
  dpopChallenge,
  protectedResourceMetadata,
  protectedResourceMetadataRoute,
  protectedResourceMetadataUrl,
} from "./identity/protected-resource-metadata.js";
import { sessionsRoute, type ConfigGate } from "./routes/sessions.js";
import { SessionContainers } from "./session-containers/session-containers.js";
import type { SessionStore } from "./session-store/session-store.js";
import { IoTickets } from "./session/io-tickets.js";
import { SessionRegistry } from "./session/registry.js";
import { callerResolver, type CallerResolver } from "./session/session-credentials.js";
import { SessionLifecycle } from "./session/session-lifecycle.js";

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
  /** Backend config gate, enforced on `POST /v1/sessions` and `PUT …/apps`
   *  (e.g. an `image` allowlist). Rejects with `400 invalid_config`. */
  validateConfig?: ConfigGate;
  /** The operator's agent catalog (usually `loadResolvedApps(process.env)`),
   *  which a session's `agent` is resolved against. */
  apps?: Record<string, ResolvedRunnerApp>;
  /** Where session records are kept (`openSessionStore`). Owned by the caller,
   *  who closes it after the server. */
  store: SessionStore;
  /** Who a request is, from its credentials — every session route asks it.
   *  Defaults to resume secrets (`Authorization: Bearer`), plus DPoP-bound
   *  identities when `config.identity` is set. */
  resolveCaller?: CallerResolver;
  /** Where the runner's own log goes. Defaults to pino's own destination
   *  (stdout), which is right for a container whose stdout IS its log — and
   *  wrong for a runner hosted inside a CLI, where stdout is the machine
   *  surface and a request line written onto it is corruption rather than
   *  noise. */
  logStream?: NodeJS.WritableStream;
  /** The waits between attempts of one session record write, after which the
   *  session is failed with the store's error. Defaults to 100 ms, 500 ms, 2 s. */
  storeRetryDelaysMs?: readonly number[];
}

export interface ServerHandle {
  app: FastifyInstance;
  registry: SessionRegistry;
  lifecycle: SessionLifecycle;
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
    // A browser client reads the DPoP challenge off a 401.
    exposedHeaders: ["WWW-Authenticate"],
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

  const registry = new SessionRegistry({ replayBufferBytes: deps.config.replayBufferBytes });
  const tickets = new IoTickets();

  // Identity is advertised from the same configuration that verifies it, so
  // the document a client reads and the check the runner makes are one
  // statement — core adds it to whatever the backend describes.
  const identityConfig = deps.config.identity;
  const identityMetadata = identityConfig ? protectedResourceMetadata(identityConfig) : undefined;
  const backendCapabilities = deps.capabilities;
  const describe =
    typeof backendCapabilities === "function" ? backendCapabilities : () => backendCapabilities;
  const capabilitiesGetter = (): RunnerCapabilities => {
    const document = { ...describe() };
    delete document.identity;
    return identityMetadata ? { ...document, identity: identityMetadata } : document;
  };
  const capabilitiesValue = capabilitiesGetter();
  const resolveCaller =
    deps.resolveCaller ??
    callerResolver({
      identity: identityConfig
        ? new IdentityVerifier({ config: identityConfig, store: deps.store, log: app.log })
        : undefined,
    });
  const agents = deps.apps ?? {};

  // The advertised feature and the backend seam are one statement: a runner
  // that says it honours a telo version over a backend that cannot be asked
  // would accept every version and run whatever it pleased.
  if (capabilitiesValue.features.teloVersions === true && !deps.backend.supplyTelo) {
    throw new RunnerConfigError(
      "this runner advertises `features.teloVersions` over a backend with no `supplyTelo` — " +
        "it would accept a telo version it has no way to honour.",
    );
  }

  // A container engine per session, served only where the operator turned it on
  // and the backend can run one: the setting and the seam are one statement,
  // like `teloVersions` and `supplyTelo`.
  let containers: SessionContainers | undefined;
  const containerSettings = deps.config.sessionContainers;
  if (containerSettings.enabled) {
    if (!deps.backend.containers) {
      throw new RunnerConfigError(
        "RUNNER_SESSION_CONTAINERS is on, but this runner's backend cannot run a session's " +
          "containers — turn it off.",
      );
    }
    containers = new SessionContainers({
      engine: deps.backend.containers,
      registry,
      store: deps.store,
      max: containerSettings.max,
      internalUrl: containerSettings.internalUrl,
      log: app.log,
    });
    await app.register(engineRoute(containers));
  }

  const lifecycle = new SessionLifecycle({
    backend: deps.backend,
    store: deps.store,
    registry,
    tickets,
    containers,
    agents,
    settings: deps.config.sessions,
    maxSessions: deps.config.maxSessions,
    log: app.log,
    ...(deps.storeRetryDelaysMs ? { storeRetryDelaysMs: deps.storeRetryDelaysMs } : {}),
  });

  await app.register(healthRoute(deps.version));
  await app.register(capabilitiesRoute(capabilitiesGetter));
  if (identityMetadata) await app.register(protectedResourceMetadataRoute(identityMetadata));
  await app.register(probeRoute({ backend: deps.backend }));
  await app.register(
    sessionsRoute({
      backend: deps.backend,
      registry,
      lifecycle,
      tickets,
      resolveCaller,
      authChallenge: identityConfig
        ? dpopChallenge(protectedResourceMetadataUrl(identityConfig.audience))
        : undefined,
      corsOrigins: deps.config.corsOrigins,
      validateConfig: deps.validateConfig,
      // The capabilities document is the single source of the runner's terms;
      // the create route enforces what /v1/capabilities advertises.
      terms: capabilitiesValue.terms,
      agents,
      reloadLimitPerMinute: deps.config.sessions.reloadLimitPerMinute,
      // Read from the advertised capabilities for the same reason terms are:
      // the document a client reads and the rule the route enforces have to be
      // one statement.
      io: capabilitiesValue.features.io,
      teloVersions: capabilitiesValue.features.teloVersions === true,
    }),
  );
  await app.register(
    ioRoute({ registry, lifecycle, tickets, corsOrigins: deps.config.corsOrigins }),
  );

  // Every stored session is loaded and every running one adopted before the
  // runner answers; then the idle, running-limit and retention sweep starts.
  // Closing detaches workloads and stops nothing that outlives the runner.
  await lifecycle.boot();
  lifecycle.start();
  app.addHook("onClose", async () => lifecycle.close());

  return { app, registry, lifecycle };
}

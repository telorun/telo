import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";

import { isEventFrame } from "@telorun/debug-wire";
import type { RunnerBackend } from "../backend.js";
import {
  ACCEPTED_TERMS_HEADER,
  SessionStartError,
  type RunBundle,
  type RunnerTerms,
  type SessionConfig,
  type StartSessionRequest,
} from "../contract.js";
import type { ResolvedRunnerApp } from "../config.js";
import { BundlePathError, normalizeBundlePath } from "../session/bundle-path.js";
import { generateSessionId } from "../session/session-id.js";
import { SessionLimitError, type SessionRegistry } from "../session/registry.js";
import { streamSessionEvents } from "../sse/channel.js";

export interface SessionsRouteDeps {
  backend: RunnerBackend;
  registry: SessionRegistry;
  corsOrigins: string[] | "*";
  /** The runner's own default registry URL, surfaced to the workload as
   *  TELO_REGISTRY_URL when the request doesn't override it. */
  defaultRegistryUrl?: string;
  /** When set, a session may only start if the client acknowledges this exact
   *  terms version via the `x-telo-accepted-terms` header. */
  terms?: RunnerTerms;
  /** Operator-predefined applications launchable by name
   *  (`StartSessionRequest.app`), with their operator env already resolved.
   *  The catalog is the whole gate — an unknown name is rejected. */
  apps?: Record<string, ResolvedRunnerApp>;
  /** Backend-supplied config gate. Returns an error message to reject the
   *  request with `400 invalid_config`, or `undefined` to accept. The runner is
   *  the source of truth, so this re-checks what `/v1/capabilities` advertises
   *  (e.g. an `image` allowlist) against a client that skipped the editor. */
  validateConfig?: (config: SessionConfig) => string | undefined;
}

// `bundle`/`config` are schema-optional because an `app` session needs neither;
// the route enforces their presence for regular bundle sessions.
const startBodySchema = {
  type: "object",
  required: ["env"],
  properties: {
    app: { type: "string", minLength: 1 },
    bundle: {
      type: "object",
      required: ["entryRelativePath", "files"],
      properties: {
        entryRelativePath: { type: "string", minLength: 1 },
        files: {
          type: "array",
          items: {
            type: "object",
            required: ["relativePath", "contents"],
            properties: {
              relativePath: { type: "string", minLength: 1 },
              contents: { type: "string" },
            },
          },
        },
      },
    },
    env: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    ports: {
      type: "array",
      items: {
        type: "object",
        required: ["port", "protocol"],
        properties: {
          port: { type: "integer", minimum: 1, maximum: 65535 },
          protocol: { type: "string", enum: ["tcp", "udp"] },
        },
      },
    },
    config: {
      type: "object",
      required: ["image", "pullPolicy"],
      properties: {
        image: { type: "string", minLength: 1 },
        pullPolicy: { type: "string", enum: ["missing", "always", "never"] },
        registryUrl: { type: "string", minLength: 1 },
      },
    },
    inspect: { type: "boolean" },
  },
} as const;

export function sessionsRoute(deps: SessionsRouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    app.post<{ Body: StartSessionRequest }>(
      "/v1/sessions",
      { schema: { body: startBodySchema } },
      async (req, reply) => {
        // Terms enforcement — the server is the source of truth, so a client that
        // skips the editor gate still can't start a session without acknowledging
        // the current terms version.
        if (deps.terms) {
          const raw = req.headers[ACCEPTED_TERMS_HEADER];
          const accepted = Array.isArray(raw) ? raw[0] : raw;
          if (accepted !== deps.terms.version) {
            reply.code(428).send({ error: "terms_required", terms: deps.terms });
            return;
          }
        }
        return startSession(app, deps, req.body, reply);
      },
    );

    app.get<{ Params: { id: string } }>("/v1/sessions/:id", async (req, reply) => {
      const entry = deps.registry.get(req.params.id);
      if (!entry) {
        reply.code(404).send({ error: "not_found", message: `session '${req.params.id}' not in registry` });
        return;
      }
      reply.send({
        sessionId: entry.sessionId,
        status: entry.status,
        createdAt: entry.createdAt.toISOString(),
        exitedAt: entry.exitedAt?.toISOString(),
      });
    });

    app.delete<{ Params: { id: string } }>("/v1/sessions/:id", async (req, reply) => {
      const entry = deps.registry.get(req.params.id);
      if (!entry) {
        reply.code(204).send();
        return;
      }
      entry.userStopped = true;
      if (entry.session) {
        try {
          await entry.session.stop();
        } catch (err) {
          app.log.error({ err, sessionId: entry.sessionId }, "failed to stop session");
          reply.code(500).send({ error: "stop_failed", message: (err as Error).message });
          return;
        }
      }
      reply.code(204).send();
    });

    app.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>(
      "/v1/sessions/:id/events",
      async (req, reply) =>
        streamSessionEvents({
          registry: deps.registry,
          req,
          reply,
          sessionId: req.params.id,
          corsOrigins: deps.corsOrigins,
        }),
    );
  };
}

async function startSession(
  app: FastifyInstance,
  deps: SessionsRouteDeps,
  body: StartSessionRequest,
  reply: FastifyReply,
): Promise<void> {
  const sessionId = generateSessionId();

  // App sessions launch an operator-predefined image by name: the catalog
  // resolves the image and operator env server-side, so the client can neither
  // pick the image nor reach the secrets — the catalog IS the gate, and an
  // unknown name is rejected here.
  const appEntry = body.app === undefined ? undefined : deps.apps?.[body.app];
  if (body.app !== undefined && !appEntry) {
    const offered = Object.keys(deps.apps ?? {});
    reply.code(400).send({
      error: "unknown_app",
      message:
        `app '${body.app}' is not offered by this runner` +
        (offered.length > 0
          ? ` — offered apps: ${offered.join(", ")}`
          : " — it offers no predefined applications") +
        " (see /v1/capabilities).",
    });
    return;
  }
  if (!appEntry && (!body.bundle || !body.config)) {
    reply.code(400).send({
      error: "invalid_request",
      message: "'bundle' and 'config' are required unless launching a predefined app via 'app'.",
    });
    return;
  }

  let bundle: RunBundle;
  let entryRelative: string;
  let config: SessionConfig;
  if (appEntry) {
    // Self-contained image — no bundle to deliver; the entry path is an unused
    // placeholder so the backend spec stays total.
    bundle = { entryRelativePath: "telo.yaml", files: [] };
    entryRelative = bundle.entryRelativePath;
    config = { image: appEntry.image, pullPolicy: appEntry.pullPolicy };
  } else {
    bundle = body.bundle!;
    config = body.config!;
    try {
      // Traversal guard for the entry path and every bundle file — a `../foo`
      // would let the workload read or execute paths outside its session dir.
      // Validated here (backend-neutral) so a bad path is a 400, not a backend
      // 500, regardless of how the backend ultimately delivers the bundle.
      entryRelative = normalizeBundlePath(bundle.entryRelativePath);
      for (const file of bundle.files) normalizeBundlePath(file.relativePath);
    } catch (err) {
      if (err instanceof BundlePathError) {
        reply.code(400).send({ error: "invalid_bundle", message: err.message });
        return;
      }
      throw err;
    }

    // Backend config gate (e.g. an image allowlist). The advertised capabilities
    // constrain the editor; this enforces the same against any client. App
    // sessions skip it — their image comes from the catalog, not the client.
    if (deps.validateConfig) {
      const message = deps.validateConfig(config);
      if (message) {
        reply.code(400).send({ error: "invalid_config", message });
        return;
      }
    }
  }

  let entry: ReturnType<SessionRegistry["register"]>;
  try {
    entry = deps.registry.register({ sessionId });
  } catch (err) {
    if (err instanceof SessionLimitError) {
      reply.code(409).send({ error: "too_many_sessions", message: err.message });
      return;
    }
    throw err;
  }

  // For an app session, drop client-supplied values for any env key the
  // catalog defines (a client must never override operator-held values, which
  // include secrets), then inject the operator's values.
  const clientEnv = appEntry
    ? {
        ...Object.fromEntries(
          Object.entries(body.env).filter(([key]) => !(key in appEntry.env)),
        ),
        ...appEntry.env,
      }
    : body.env;

  // Surface a TELO_REGISTRY_URL to the workload so the telo CLI inside picks
  // it up. Precedence: explicit env value > config.registryUrl (per-request
  // override) > runner's own default. Trim client-supplied URLs so stray
  // whitespace from an editor input doesn't flow into the workload.
  const configRegistryUrl = config.registryUrl?.trim() || undefined;
  const registryUrl = configRegistryUrl ?? deps.defaultRegistryUrl;
  const sessionEnv =
    registryUrl && !("TELO_REGISTRY_URL" in clientEnv)
      ? { ...clientEnv, TELO_REGISTRY_URL: registryUrl }
      : clientEnv;

  // Respond as soon as the session is registered — BEFORE the backend starts.
  // `backend.start()` now spans the on-cluster image build and pod bring-up,
  // which can take seconds-to-minutes; awaiting it here would hide the event
  // stream until the workload is already up, so the client never sees build /
  // provision / boot progress live. Returning the streamUrl first lets the
  // client connect immediately; start runs in the background and its progress,
  // output, and terminal status flow over the stream.
  reply.code(201).send({
    sessionId,
    streamUrl: `/v1/sessions/${sessionId}/events`,
    createdAt: entry.createdAt.toISOString(),
  });

  deps.backend
    .start({
      sessionId,
      bundle,
      entryRelativePath: entryRelative,
      env: sessionEnv,
      ports: body.ports ?? [],
      config,
      selfContained: appEntry !== undefined,
      inspect: body.inspect ?? false,
      onStatus: (status) => deps.registry.emit(sessionId, { type: "status", status }),
      onProgress: (phase, message, done) =>
        deps.registry.emit(sessionId, { type: "progress", phase, message, done }),
      onOutput: (chunk) => deps.registry.pushBytes(sessionId, chunk),
      // Relay only kernel *event* frames to the client. stdout/stderr already
      // arrive over the byte channel (onOutput), so forwarding log frames would
      // double the traffic and let log spam evict lifecycle events from the
      // byte-capped replay buffer. The editor discards relayed logs anyway.
      onDebug: (frame) => {
        if (isEventFrame(frame)) deps.registry.emit(sessionId, { type: "debug", frame });
      },
      onReachability: (port, state) =>
        deps.registry.emit(sessionId, { type: "reachability", port, state }),
      isUserStopped: () => entry.userStopped,
    })
    .then(async (session) => {
      entry.session = session;
      // Pre-start DELETE race: a DELETE received during backend.start (e.g.
      // while an image build was running) can't stop a workload that didn't
      // exist yet — it set userStopped and returned 204. Now that the workload
      // is live, honor the earlier DELETE.
      if (entry.userStopped) {
        try {
          await session.stop();
        } catch (err) {
          app.log.warn({ err, sessionId }, "failed to stop after race with pre-start DELETE");
        }
      }
    })
    .catch((err) => {
      // The 201 is already sent, so a start failure surfaces as a terminal
      // `failed` status on the stream (the registry schedules eviction on a
      // terminal status; the SSE channel delivers it, then closes).
      const message =
        err instanceof SessionStartError
          ? `${err.stage}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      app.log.error({ err, sessionId }, "session start failed");
      deps.registry.emit(sessionId, { type: "status", status: { kind: "failed", message } });
    });
}

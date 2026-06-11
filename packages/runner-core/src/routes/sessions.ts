import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";

import type { RunnerBackend } from "../backend.js";
import { SessionStartError, type StartSessionRequest } from "../contract.js";
import { BundlePathError, normalizeBundlePath } from "../session/bundle-path.js";
import { SessionLimitError, type SessionRegistry } from "../session/registry.js";
import { streamSessionEvents } from "../sse/channel.js";

export interface SessionsRouteDeps {
  backend: RunnerBackend;
  registry: SessionRegistry;
  corsOrigins: string[] | "*";
  /** The runner's own default registry URL, surfaced to the workload as
   *  TELO_REGISTRY_URL when the request doesn't override it. */
  defaultRegistryUrl?: string;
}

const startBodySchema = {
  type: "object",
  required: ["bundle", "env", "config"],
  properties: {
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
  },
} as const;

export function sessionsRoute(deps: SessionsRouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    app.post<{ Body: StartSessionRequest }>(
      "/v1/sessions",
      { schema: { body: startBodySchema } },
      async (req, reply) => startSession(app, deps, req.body, reply),
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
  const sessionId = randomUUID();

  let entryRelative: string;
  try {
    // Traversal guard for the entry path and every bundle file — a `../foo`
    // would let the workload read or execute paths outside its session dir.
    // Validated here (backend-neutral) so a bad path is a 400, not a backend
    // 500, regardless of how the backend ultimately delivers the bundle.
    entryRelative = normalizeBundlePath(body.bundle.entryRelativePath);
    for (const file of body.bundle.files) normalizeBundlePath(file.relativePath);
  } catch (err) {
    if (err instanceof BundlePathError) {
      reply.code(400).send({ error: "invalid_bundle", message: err.message });
      return;
    }
    throw err;
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

  // Surface a TELO_REGISTRY_URL to the workload so the telo CLI inside picks
  // it up. Precedence: body.env explicit value > body.config.registryUrl
  // (per-request override) > runner's own default. Trim client-supplied URLs
  // so stray whitespace from an editor input doesn't flow into the workload.
  const configRegistryUrl = body.config.registryUrl?.trim() || undefined;
  const registryUrl = configRegistryUrl ?? deps.defaultRegistryUrl;
  const sessionEnv =
    registryUrl && !("TELO_REGISTRY_URL" in body.env)
      ? { ...body.env, TELO_REGISTRY_URL: registryUrl }
      : body.env;

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
      bundle: body.bundle,
      entryRelativePath: entryRelative,
      env: sessionEnv,
      ports: body.ports ?? [],
      config: body.config,
      onStatus: (status) => deps.registry.emit(sessionId, { type: "status", status }),
      onProgress: (phase, message, done) =>
        deps.registry.emit(sessionId, { type: "progress", phase, message, done }),
      onOutput: (chunk) => deps.registry.pushBytes(sessionId, chunk),
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

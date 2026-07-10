import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";

import type { RunnerBackend } from "../backend.js";
import type { RunnerTerms, SessionConfig, StartSessionRequest } from "../contract.js";
import { BundlePathError, normalizeBundlePath } from "../session/bundle-path.js";
import type { SessionRegistry } from "../session/registry.js";
import { enforceTerms, portsSchema, startWorkloadSession } from "./session-start.js";
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
  /** Backend-supplied config gate. Returns an error message to reject the
   *  request with `400 invalid_config`, or `undefined` to accept. The runner is
   *  the source of truth, so this re-checks what `/v1/capabilities` advertises
   *  (e.g. an `image` allowlist) against a client that skipped the editor. */
  validateConfig?: (config: SessionConfig) => string | undefined;
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
    ports: portsSchema,
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
        if (!enforceTerms(req, reply, deps.terms)) return;
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

  // Backend config gate (e.g. an image allowlist). The advertised capabilities
  // constrain the editor; this enforces the same against any client.
  if (deps.validateConfig) {
    const message = deps.validateConfig(body.config);
    if (message) {
      reply.code(400).send({ error: "invalid_config", message });
      return;
    }
  }

  return startWorkloadSession(
    app,
    deps,
    {
      bundle: body.bundle,
      entryRelativePath: entryRelative,
      env: body.env,
      ports: body.ports ?? [],
      config: body.config,
      selfContained: false,
      inspect: body.inspect ?? false,
    },
    reply,
  );
}

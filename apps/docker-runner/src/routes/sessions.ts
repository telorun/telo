import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";

import type { RunnerConfig } from "../config.js";
import { spawnSession, stopContainer, type SessionDockerClient } from "../docker/run-session.js";
import { BundleWorkdir, BundleWorkdirError, normalizeBundlePath } from "../session/bundle-workdir.js";
import {
  SessionLimitError,
  type SessionRegistry,
} from "../session/registry.js";
import { streamSessionEvents } from "../sse/channel.js";
import { SessionStartError, type StartSessionRequest } from "../types.js";

export interface SessionsRouteDeps {
  docker: SessionDockerClient;
  registry: SessionRegistry;
  runnerConfig: Pick<
    RunnerConfig,
    "bundleRoot" | "bundleVolume" | "childNetwork" | "corsOrigins"
  >;
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
    config: {
      type: "object",
      required: ["image", "pullPolicy"],
      properties: {
        image: { type: "string", minLength: 1 },
        pullPolicy: { type: "string", enum: ["missing", "always", "never"] },
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
      if (entry.container) {
        try {
          await stopContainer(entry.container);
        } catch (err) {
          app.log.error({ err, sessionId: entry.sessionId }, "failed to stop container");
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
          corsOrigins: deps.runnerConfig.corsOrigins,
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
  const containerName = `telo-run-${sessionId}`;
  const workingDir = `/srv/${sessionId}`;

  let bundleWorkdir: BundleWorkdir | null = null;
  let entry: ReturnType<SessionRegistry["register"]> | null = null;

  let entryRelative: string;
  try {
    // Same traversal guard as files[].relativePath — an entryRelativePath of
    // `../foo` would make the spawned container execute a path outside its
    // own session dir (still within the shared bundle volume, but readable
    // peer-session files).
    entryRelative = normalizeBundlePath(body.bundle.entryRelativePath);
  } catch (err) {
    if (err instanceof BundleWorkdirError) {
      reply.code(400).send({ error: "invalid_bundle", message: err.message });
      return;
    }
    throw err;
  }

  try {
    try {
      bundleWorkdir = await BundleWorkdir.create(
        deps.runnerConfig.bundleRoot,
        sessionId,
        body.bundle,
      );
    } catch (err) {
      if (err instanceof BundleWorkdirError) {
        reply.code(400).send({ error: "invalid_bundle", message: err.message });
        return;
      }
      throw err;
    }

    try {
      entry = deps.registry.register({ sessionId, containerName, bundleWorkdir });
    } catch (err) {
      if (err instanceof SessionLimitError) {
        await bundleWorkdir.cleanup();
        reply.code(409).send({ error: "too_many_sessions", message: err.message });
        return;
      }
      throw err;
    }

    const { container } = await spawnSession({
      docker: deps.docker,
      sessionId,
      containerName,
      image: body.config.image,
      pullPolicy: body.config.pullPolicy,
      entryRelativePath: `./${entryRelative}`,
      workingDir,
      env: body.env,
      bundleVolume: deps.runnerConfig.bundleVolume,
      childNetwork: deps.runnerConfig.childNetwork,
      onEvent: (event) => deps.registry.emit(sessionId, event),
      isUserStopped: () => entry?.userStopped ?? false,
    });

    entry.container = container;

    // Pre-start DELETE race: a DELETE received during spawnSession (e.g. while
    // docker.pull was running) can't call container.kill() because the
    // container didn't exist yet — it sets userStopped and returns 204. Now
    // that spawn is done and the container is live, honor the earlier DELETE.
    if (entry.userStopped) {
      try {
        await stopContainer(container);
      } catch (err) {
        app.log.warn(
          { err, sessionId },
          "failed to kill container after race with pre-start DELETE",
        );
      }
    }

    reply.code(201).send({
      sessionId,
      streamUrl: `/v1/sessions/${sessionId}/events`,
      createdAt: entry.createdAt.toISOString(),
    });
  } catch (err) {
    if (entry) deps.registry.remove(entry.sessionId);
    if (bundleWorkdir) {
      try {
        await bundleWorkdir.cleanup();
      } catch (cleanupErr) {
        app.log.error({ err: cleanupErr, sessionId }, "failed to clean up bundle workdir");
      }
    }

    if (err instanceof SessionStartError) {
      const statusCode = err.kind === "pull_failed" ? 502 : 503;
      reply.code(statusCode).send({
        error: err.kind,
        stage: err.stage,
        message: err.message,
        daemonMessage: err.daemonMessage,
      });
      return;
    }

    app.log.error({ err, sessionId }, "unexpected start error");
    reply.code(500).send({ error: "internal", message: (err as Error).message });
  }
}

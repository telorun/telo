import { Readable } from "node:stream";

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { admitCreate, isRefusal } from "../session-containers/create-request.js";
import {
  SessionContainerFieldRefused,
  SessionContainerNotFound,
  type SessionContainerOutput,
} from "../session-containers/session-container-engine.js";
import type { SessionContainer, SessionContainers } from "../session-containers/session-containers.js";

/** The Engine API version this endpoint answers, and the only one. */
const API_VERSION = "v1.41";
const MULTIPLEXED_STREAM = "application/vnd.docker.multiplexed-stream";
const STREAM_IDS = { stdout: 1, stderr: 2 } as const;

/** What a request outside the subset is told. */
const SUBSET =
  "ping, image inspect and pull, container create, start, inspect, logs, list by label and delete";

type Params = { id: string };
type ContainerParams = { id: string; cid: string };

/**
 * A session's container engine: the Docker Engine API 1.41 subset `Docker.Engine`
 * speaks, at `/v1/sessions/:id/engine/v1.41/…`, behind the session's bearer
 * token and scoped to the containers that session started. Every request
 * outside the subset is refused.
 */
export function engineRoute(containers: SessionContainers): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const base = `/v1/sessions/:id/engine/${API_VERSION}`;

    app.addHook("preClose", async () => containers.shutdown());

    app.get<{ Params: Params }>(`${base}/_ping`, async (req, reply) => {
      if (!admit(containers, req, reply)) return;
      await containers.engine.ping();
      reply.type("text/plain").send("OK");
    });

    app.get<{ Params: Params & { "*": string } }>(`${base}/images/*`, async (req, reply) => {
      if (!admit(containers, req, reply)) return;
      const rest = req.params["*"];
      if (!rest.endsWith("/json")) return outsideSubset(req, reply);
      const image = rest.slice(0, -"/json".length);
      if (!(await containers.engine.hasImage(image))) {
        reply.code(404).send({ message: `No such image: ${image}` });
        return;
      }
      reply.send({ Id: image, RepoTags: [image] });
    });

    app.post<{ Params: Params; Querystring: { fromImage?: string; tag?: string } }>(
      `${base}/images/create`,
      async (req, reply) => {
        if (!admit(containers, req, reply)) return;
        const { fromImage, tag } = req.query;
        if (!fromImage) {
          reply.code(400).send({ message: "fromImage: is required" });
          return;
        }
        const image = tag ? `${fromImage}:${tag}` : fromImage;
        await containers.engine.pullImage(image);
        reply.type("application/json").send(`${JSON.stringify({ status: `Pulled ${image}` })}\n`);
      },
    );

    app.post<{ Params: Params; Querystring: Record<string, unknown> }>(
      `${base}/containers/create`,
      async (req, reply) => {
        if (!admit(containers, req, reply)) return;
        const query = Object.keys(req.query ?? {});
        if (query.length > 0) {
          reply.code(400).send({ message: `${query[0]}: is not accepted by this engine` });
          return;
        }
        const admitted = admitCreate(req.body, req.params.id);
        if (isRefusal(admitted)) {
          reply.code(400).send({ message: `${admitted.field}: ${admitted.message}` });
          return;
        }
        const outcome = await containers.create(req.params.id, admitted);
        if (outcome.kind === "ceiling") {
          reply.code(429).send({
            message: `this session may hold at most ${outcome.max} containers at once; remove one first`,
          });
          return;
        }
        if (outcome.kind === "ended") {
          reply.code(409).send({ message: "the session's workload has ended" });
          return;
        }
        reply.code(201).send({ Id: outcome.id, Warnings: [] });
      },
    );

    app.get<{ Params: Params; Querystring: { all?: string; filters?: string } }>(
      `${base}/containers/json`,
      async (req, reply) => {
        if (!admit(containers, req, reply)) return;
        if (req.query.all !== "true" && req.query.all !== "1") {
          reply.code(400).send({
            message: "all: this engine lists every container of the session, so send all=true",
          });
          return;
        }
        const labels = labelFilters(req.query.filters);
        if (typeof labels === "string") {
          reply.code(400).send({ message: labels });
          return;
        }
        reply.send(
          containers
            .list(req.params.id)
            .filter((container) => labels.every((filter) => matchesLabel(container, filter)))
            .map((container) => ({ Id: container.id, Image: container.image, Labels: container.labels })),
        );
      },
    );

    app.post<{ Params: ContainerParams }>(`${base}/containers/:cid/start`, async (req, reply) => {
      const container = owned(containers, req, reply);
      if (!container) return;
      const request = containers.track();
      reply.raw.on("close", () => request.done());
      try {
        await containers.engine.start(req.params.id, container.id, request.signal);
      } finally {
        request.done();
      }
      reply.code(204).send();
    });

    app.get<{ Params: ContainerParams }>(`${base}/containers/:cid/json`, async (req, reply) => {
      const container = owned(containers, req, reply);
      if (!container) return;
      const state = await containers.engine.inspect(req.params.id, container.id);
      const reachable = state.running && state.address !== undefined;
      reply.send({
        Id: container.id,
        Image: container.image,
        State: {
          Status: state.running ? "running" : state.exitCode === null ? "created" : "exited",
          Running: state.running,
          ExitCode: state.exitCode ?? 0,
        },
        Config: {
          Image: container.image,
          Labels: container.labels,
          ExposedPorts: Object.fromEntries(container.ports.map((port) => [`${port}/tcp`, {}])),
        },
        NetworkSettings: {
          // The binding a create asked for, answered with the address the
          // session reaches the container at. Nothing is published on a host.
          Ports: Object.fromEntries(
            container.ports.map((port) => [
              `${port}/tcp`,
              reachable && container.bound.includes(port)
                ? [{ HostIp: state.address, HostPort: String(port) }]
                : null,
            ]),
          ),
        },
      });
    });

    app.get<{ Params: ContainerParams; Querystring: { follow?: string; tail?: string } }>(
      `${base}/containers/:cid/logs`,
      async (req, reply) => {
        const container = owned(containers, req, reply);
        if (!container) return;
        const tail = req.query.tail;
        if (tail !== undefined && tail !== "all" && !/^\d+$/.test(tail)) {
          reply.code(400).send({ message: "tail: must be a number of lines or all" });
          return;
        }
        const request = containers.track();
        const abortOnClose = new AbortController();
        reply.raw.on("close", () => {
          request.done();
          abortOnClose.abort();
        });
        const signal = AbortSignal.any([request.signal, abortOnClose.signal]);
        const output = await containers.engine.logs(
          req.params.id,
          container.id,
          {
            follow: req.query.follow === "true" || req.query.follow === "1",
            ...(tail !== undefined && tail !== "all" ? { tail: Number(tail) } : {}),
          },
          signal,
        );
        return reply.type(MULTIPLEXED_STREAM).send(Readable.from(frames(output)));
      },
    );

    app.delete<{ Params: ContainerParams }>(`${base}/containers/:cid`, async (req, reply) => {
      const container = owned(containers, req, reply);
      if (!container) return;
      await containers.remove(req.params.id, container.id);
      reply.code(204).send();
    });

    app.all<{ Params: Params }>("/v1/sessions/:id/engine/*", async (req, reply) => {
      if (!admit(containers, req, reply)) return;
      outsideSubset(req, reply);
    });

    // Encapsulated in this plugin, so it answers only the engine's routes, in
    // the engine's own `{ message }` shape.
    app.setErrorHandler(async (err, req, reply) => {
      const id = (req.params as Partial<ContainerParams>)?.cid;
      if (err instanceof SessionContainerNotFound) {
        if (id) containers.forget((req.params as ContainerParams).id, id);
        reply.code(404).send({ message: err.message });
        return;
      }
      if (err instanceof SessionContainerFieldRefused) {
        reply.code(400).send({ message: `${err.field}: ${err.message}` });
        return;
      }
      req.log.error({ err }, "session container engine request failed");
      reply.code(500).send({ message: err instanceof Error ? err.message : String(err) });
    });
  };
}

/** Authenticate the session's bearer token; answers the refusal itself. */
function admit(
  containers: SessionContainers,
  req: FastifyRequest<{ Params: Params }>,
  reply: FastifyReply,
): boolean {
  switch (containers.authorize(req.params.id, req.headers.authorization)) {
    case "ok":
      return true;
    case "unknown_session":
      reply.code(404).send({ message: `no container engine is served to session '${req.params.id}'` });
      return false;
    case "missing_token":
      reply.code(401).send({ message: "this engine needs the session's bearer token" });
      return false;
    case "wrong_token":
      reply.code(403).send({ message: "this token does not admit the session" });
      return false;
  }
}

/** A container of THIS session, or the 404 a foreign or unknown id gets. */
function owned(
  containers: SessionContainers,
  req: FastifyRequest<{ Params: ContainerParams }>,
  reply: FastifyReply,
): SessionContainer | undefined {
  if (!admit(containers, req, reply)) return undefined;
  const container = containers.get(req.params.id, req.params.cid);
  if (!container) reply.code(404).send({ message: `No such container: ${req.params.cid}` });
  return container;
}

function outsideSubset(req: FastifyRequest, reply: FastifyReply): void {
  reply.code(404).send({
    message:
      `${req.method} ${req.url.replace(/^\/v1\/sessions\/[^/]+\/engine/, "")} is not served by ` +
      `this engine, which answers the Docker Engine API ${API_VERSION} subset: ${SUBSET}`,
  });
}

/** The `label` filters of a list, or why they are refused. */
function labelFilters(raw: string | undefined): string[] | string {
  if (raw === undefined || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "filters: must be JSON";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "filters: must be a JSON object";
  }
  const labels: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "label") return `filters.${key}: is not accepted by this engine`;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      return "filters.label: must be a list of strings";
    }
    labels.push(...(value as string[]));
  }
  return labels;
}

function matchesLabel(container: SessionContainer, filter: string): boolean {
  const eq = filter.indexOf("=");
  if (eq === -1) return Object.hasOwn(container.labels, filter);
  return container.labels[filter.slice(0, eq)] === filter.slice(eq + 1);
}

/** The engine's log framing: per chunk an 8-byte header — the stream id, three
 *  zero bytes, the payload length as a big-endian uint32 — then the payload. */
async function* frames(output: AsyncIterable<SessionContainerOutput>): AsyncIterable<Buffer> {
  for await (const chunk of output) {
    if (chunk.data.length === 0) continue;
    const header = Buffer.alloc(8);
    header[0] = STREAM_IDS[chunk.stream];
    header.writeUInt32BE(chunk.data.length, 4);
    yield Buffer.concat([header, chunk.data]);
  }
}

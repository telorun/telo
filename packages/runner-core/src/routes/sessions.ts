import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { RunnerBackend } from "../backend.js";
import type { ResolvedRunnerApp } from "../config.js";
import {
  ACCEPTED_TERMS_HEADER,
  type AdoptSessionRequest,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type IoMode,
  type RunAppRequest,
  type RunnerTerms,
  type SessionAppSpec,
  type SessionConfig,
  type SessionList,
  type WorkspaceChangeSet,
} from "../contract.js";
import {
  admitAgent,
  refuseReservedPorts,
  refuseTooManyApps,
  resolveApps,
  supplyTeloVersions,
} from "../session/app-set.js";
import { BundlePathError, normalizeBundlePath } from "../session/bundle-path.js";
import type { IoTickets } from "../session/io-tickets.js";
import type { SessionEntry, SessionRegistry } from "../session/registry.js";
import {
  mintResumeSecret,
  ownsSession,
  resumeSecretHash,
  type CallerResolver,
} from "../session/session-credentials.js";
import type { SessionOwner } from "../session-store/session-store.js";
import type { SessionLifecycle } from "../session/session-lifecycle.js";
import { SessionRefusal } from "../session/session-refusal.js";
import { streamSessionEvents } from "../sse/channel.js";

export interface SessionsRouteDeps {
  backend: RunnerBackend;
  registry: SessionRegistry;
  lifecycle: SessionLifecycle;
  tickets: IoTickets;
  /** Who a request is, from its credentials. */
  resolveCaller: CallerResolver;
  /** `WWW-Authenticate` on a 401 for a missing credential, on a runner that
   *  takes identity. */
  authChallenge?: string;
  corsOrigins: string[] | "*";
  /** When set, a session may only be created if the client acknowledges this
   *  exact terms version via the `x-telo-accepted-terms` header. */
  terms?: RunnerTerms;
  /** Backend-supplied config gate. Returns an error message to reject the
   *  request with `400 invalid_config`, or `undefined` to accept. */
  validateConfig?: ConfigGate;
  /** Whether an application's `telo` version is honoured — what
   *  `/v1/capabilities` advertises as `features.teloVersions`. */
  teloVersions: boolean;
  /** The operator catalog a session's `agent` is resolved against. */
  agents: Record<string, ResolvedRunnerApp>;
  /** `SessionLifecycleConfig.reloadLimitPerMinute`. */
  reloadLimitPerMinute: number;
  /** The byte-channel modes this runner offers — the same list
   *  `/v1/capabilities` advertises as `features.io`. A Run asking for another
   *  is REFUSED rather than downgraded: `isatty()` is observable to the
   *  application. */
  io: IoMode[];
}

/**
 * The runner's own answer to "is this session config acceptable". `telo` says
 * whether the app set names a telo version for any application: a backend whose
 * config can also choose what runs (an image) refuses the two together.
 */
export type ConfigGate = (
  config: SessionConfig,
  request: { telo: boolean },
) => string | undefined;

const portsSchema = {
  type: "array",
  items: {
    type: "object",
    required: ["port", "protocol"],
    properties: {
      port: { type: "integer", minimum: 1, maximum: 65535 },
      protocol: { type: "string", enum: ["tcp", "udp"] },
    },
  },
} as const;

const appsSchema = {
  type: "array",
  items: {
    type: "object",
    required: ["name", "entryRelativePath"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 63 },
      entryRelativePath: { type: "string", minLength: 1 },
      ports: portsSchema,
      telo: { type: "string", minLength: 1 },
    },
  },
} as const;

const createBodySchema = {
  type: "object",
  required: ["workspace", "apps"],
  additionalProperties: false,
  properties: {
    workspace: { type: "string", minLength: 1, maxLength: 512 },
    agent: { type: "string", minLength: 1 },
    apps: appsSchema,
    // Opaque here, on purpose: what a session config may contain is the
    // runner's own answer (`/v1/capabilities`), enforced by `validateConfig`.
    config: { type: "object" },
  },
} as const;

const runBodySchema = {
  type: "object",
  required: ["env", "io"],
  additionalProperties: false,
  properties: {
    env: { type: "object", additionalProperties: { type: "string" } },
    io: { type: "string", enum: ["tty", "streams"] },
    cols: { type: "integer", minimum: 1, maximum: 10_000 },
    rows: { type: "integer", minimum: 1, maximum: 10_000 },
  },
} as const;

const changeSetSchema = {
  type: "object",
  properties: {
    write: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string", minLength: 1 },
          content: { type: "string" },
          encoding: { type: "string", enum: ["utf8", "base64"] },
        },
      },
    },
    delete: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

type IdParams = { Params: { id: string } };
type AppParams = { Params: { id: string; app: string } };

export function sessionsRoute(deps: SessionsRouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    // Every refusal the lifecycle or the app-set rules throw is answered as is.
    app.setErrorHandler(async (err, req, reply) => {
      if (err instanceof SessionRefusal) {
        await reply.code(err.status).send(err.body);
        return;
      }
      throw err;
    });

    app.post<{ Body: CreateSessionRequest }>(
      "/v1/sessions",
      { schema: { body: createBodySchema } },
      async (req, reply) => {
        if (!acceptsTerms(req, reply, deps.terms)) return;
        const resolved = await deps.resolveCaller(req);
        if ("refusal" in resolved) return refuse(reply, resolved.refusal);
        if (resolved.caller.kind === "owner" && resolved.caller.owner.kind === "secret") {
          throw new SessionRefusal(
            400,
            "resume_secret_on_create",
            "a resume secret names one session — create a session without one, and keep the " +
              "secret its answer carries",
          );
        }
        const body = req.body;
        const config = body.config ?? {};
        const apps = resolveApps(body.apps, deps.teloVersions);
        refuseTooManyApps(deps.backend, apps);
        refuseReservedPorts(deps.backend, apps);
        gateConfig(deps, config, apps.some((a) => a.telo !== undefined));
        await supplyTeloVersions(deps.backend, apps, config);
        const { agent, notice } = admitAgent(body.agent, deps.agents, apps, "drop");

        // No identity: the session is owned by a resume secret, answered once.
        const minted = resolved.caller.kind === "anonymous" ? mintResumeSecret() : undefined;
        const owner = resolved.caller.kind === "owner" ? resolved.caller.owner : minted!.owner;
        const outcome = await deps.lifecycle.create({
          owner,
          workspace: body.workspace,
          apps,
          agent,
          config,
          notices: notice ? [notice] : [],
        });
        if (outcome.kind === "exists") {
          throw new SessionRefusal(
            409,
            "session_exists",
            `this owner already has a session for workspace '${body.workspace}'`,
            { sessionId: outcome.id },
          );
        }
        const sessionId = outcome.entry.sessionId;
        const response: CreateSessionResponse = {
          sessionId,
          streamUrl: `/v1/sessions/${sessionId}/events`,
          createdAt: outcome.entry.record.createdAt.toISOString(),
          ...(minted ? { resumeSecret: minted.secret } : {}),
        };
        reply.code(201).send(response);
      },
    );

    app.get<{ Querystring: { workspace?: string } }>(
      "/v1/sessions",
      {
        schema: {
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: { workspace: { type: "string", minLength: 1, maxLength: 512 } },
          },
        },
      },
      async (req, reply) => {
        const owner = await identityOwner(deps, req, reply, "a session list");
        if (!owner) return;
        const workspace = req.query.workspace;
        const list: SessionList = {
          sessions: deps.registry
            .list()
            .filter((e) => ownsSession(owner, e.record.owner))
            .filter((e) => workspace === undefined || e.record.workspace === workspace)
            .sort((a, b) => b.record.lastActiveAt.getTime() - a.record.lastActiveAt.getTime())
            .map((e) => ({
              sessionId: e.sessionId,
              workspace: e.record.workspace,
              status: e.status.kind,
              lastActiveAt: e.record.lastActiveAt.toISOString(),
            })),
        };
        reply.send(list);
      },
    );

    // Adoption: the resume secret travels in the body, because `Authorization`
    // carries the identity it is handed to.
    app.post<IdParams & { Body: AdoptSessionRequest }>(
      "/v1/sessions/:id/owner",
      {
        schema: {
          body: {
            type: "object",
            required: ["resumeSecret"],
            additionalProperties: false,
            properties: { resumeSecret: { type: "string", minLength: 1 } },
          },
        },
      },
      async (req, reply) => {
        const owner = await identityOwner(deps, req, reply, "adopting a session");
        if (!owner) return;
        const entry = deps.registry.get(req.params.id);
        const secretOwner: SessionOwner = {
          kind: "secret",
          secretHash: resumeSecretHash(req.body.resumeSecret),
        };
        if (!entry || !ownsSession(secretOwner, entry.record.owner)) {
          reply.code(404).send({ error: "not_found", message: `no session '${req.params.id}'` });
          return;
        }
        const result = await deps.lifecycle.changeOwner(entry, owner);
        if (result.kind === "exists") {
          throw new SessionRefusal(
            409,
            "session_exists",
            `this identity already has a session for workspace '${entry.record.workspace}'`,
            { sessionId: result.id },
          );
        }
        if (result.kind === "not_found") {
          reply.code(404).send({ error: "not_found", message: `no session '${req.params.id}'` });
          return;
        }
        reply.send({ sessionId: entry.sessionId });
      },
    );

    app.get<IdParams>("/v1/sessions/:id", async (req, reply) => {
      const entry = await ownedSession(deps, req, reply);
      if (!entry) return;
      reply.send(sessionDocument(entry));
    });

    app.delete<IdParams>("/v1/sessions/:id", async (req, reply) => {
      const entry = await ownedSession(deps, req, reply);
      if (!entry) return;
      await deps.lifecycle.delete(entry);
      reply.code(204).send();
    });

    app.get<IdParams & { Querystring: { lastEventId?: string } }>(
      "/v1/sessions/:id/events",
      async (req, reply) => {
        const entry = await ownedSession(deps, req, reply);
        if (!entry) return;
        return streamSessionEvents({
          registry: deps.registry,
          req,
          reply,
          sessionId: entry.sessionId,
          corsOrigins: deps.corsOrigins,
        });
      },
    );

    app.put<IdParams & { Body: { apps: SessionAppSpec[] } }>(
      "/v1/sessions/:id/apps",
      {
        schema: {
          body: {
            type: "object",
            required: ["apps"],
            additionalProperties: false,
            properties: { apps: appsSchema },
          },
        },
      },
      async (req, reply) => {
        const entry = await ownedSession(deps, req, reply);
        if (!entry) return;
        const apps = resolveApps(req.body.apps, deps.teloVersions);
        refuseTooManyApps(deps.backend, apps);
        refuseReservedPorts(deps.backend, apps);
        // The session's config was accepted for the apps it started with; a new
        // set must not change who chooses what runs out from under it.
        gateConfig(deps, entry.record.config, apps.some((a) => a.telo !== undefined));
        await supplyTeloVersions(deps.backend, apps, entry.record.config);
        await deps.lifecycle.setApps(entry, apps);
        reply.code(202).send({ apps: apps.map((a) => a.name) });
      },
    );

    app.put<IdParams & { Body: { name: string | null } }>(
      "/v1/sessions/:id/agent",
      {
        schema: {
          body: {
            type: "object",
            required: ["name"],
            additionalProperties: false,
            properties: { name: { type: ["string", "null"], minLength: 1 } },
          },
        },
      },
      async (req, reply) => {
        const entry = await ownedSession(deps, req, reply);
        if (!entry) return;
        const { agent } = admitAgent(req.body.name, deps.agents, entry.record.apps, "refuse");
        await deps.lifecycle.setAgent(entry, agent);
        reply.code(202).send({ agent: agent?.name ?? null });
      },
    );

    app.post<AppParams & { Body: RunAppRequest }>(
      "/v1/sessions/:id/apps/:app/run",
      { schema: { body: runBodySchema } },
      async (req, reply) => {
        const entry = await ownedSession(deps, req, reply);
        if (!entry) return;
        if (!deps.io.includes(req.body.io)) {
          throw new SessionRefusal(
            400,
            "io_unsupported",
            `this runner does not offer io mode '${req.body.io}' (see /v1/capabilities) — ` +
              `it serves ${deps.io.join(", ")}`,
          );
        }
        const { runId } = await deps.lifecycle.run(entry, req.params.app, req.body);
        reply.code(202).send({ runId });
      },
    );

    app.post<AppParams>("/v1/sessions/:id/apps/:app/stop", async (req, reply) => {
      const entry = await ownedSession(deps, req, reply);
      if (!entry) return;
      const runId = await deps.lifecycle.stop(entry, req.params.app);
      reply.code(202).send({ runId: runId ?? null });
    });

    app.post<IdParams>("/v1/sessions/:id/suspend", async (req, reply) => {
      const entry = await ownedSession(deps, req, reply);
      if (!entry) return;
      await deps.lifecycle.suspend(entry);
      reply.code(202).send({ sessionId: entry.sessionId });
    });

    app.post<IdParams>("/v1/sessions/:id/resume", async (req, reply) => {
      const entry = await ownedSession(deps, req, reply);
      if (!entry) return;
      await deps.lifecycle.resume(entry);
      reply.code(202).send({ sessionId: entry.sessionId });
    });

    app.post<IdParams & { Body: { app: string } }>(
      "/v1/sessions/:id/io-tickets",
      {
        schema: {
          body: {
            type: "object",
            required: ["app"],
            additionalProperties: false,
            properties: { app: { type: "string", minLength: 1 } },
          },
        },
      },
      async (req, reply) => {
        const entry = await ownedSession(deps, req, reply);
        if (!entry) return;
        if (!entry.apps.has(req.body.app)) {
          throw new SessionRefusal(404, "unknown_app", `session runs no app named '${req.body.app}'`);
        }
        reply.code(201).send(deps.tickets.mint(entry.sessionId, req.body.app));
      },
    );

    // ---- Workspace surface -------------------------------------------------
    // Every write from OUTSIDE the workload goes through these; the co-resident
    // agent writes the same files directly with its own filesystem tools.

    app.get<IdParams>("/v1/sessions/:id/workspace", async (req, reply) => {
      const entry = await ownedSession(deps, req, reply);
      if (!entry) return;
      reply.send(await liveWorkspace(entry).tree());
    });

    app.post<IdParams & { Body: WorkspaceChangeSet }>(
      "/v1/sessions/:id/workspace",
      { schema: { body: changeSetSchema } },
      async (req, reply) => {
        const entry = await ownedSession(deps, req, reply);
        if (!entry) return;
        const workspace = liveWorkspace(entry);
        // The reload budget belongs on the route that CAUSES reloads: one write
        // per save, each triggering a kernel reload.
        admitReload(entry, deps.reloadLimitPerMinute, "workspace writes");
        for (const w of req.body.write ?? []) checkedPath(w.path);
        for (const p of req.body.delete ?? []) checkedPath(p);
        reply.send(await workspace.apply(req.body));
      },
    );

    app.get<IdParams & { Querystring: { path?: string } }>(
      "/v1/sessions/:id/workspace/file",
      async (req, reply) => {
        const entry = await ownedSession(deps, req, reply);
        if (!entry) return;
        const workspace = liveWorkspace(entry);
        const path = req.query.path?.trim();
        if (!path) throw new SessionRefusal(400, "invalid_path", "?path= is required");
        checkedPath(path);
        reply.send(await workspace.readFile(path));
      },
    );

    // Re-runs a live app with no file change, by touching its entry manifest
    // through the same write path everything else uses.
    app.post<IdParams & { Querystring: { app?: string } }>(
      "/v1/sessions/:id/reload",
      async (req, reply) => {
        const entry = await ownedSession(deps, req, reply);
        if (!entry) return;
        const workload = entry.workload;
        if (entry.status.kind !== "running" || !workload) {
          throw new SessionRefusal(409, "not_running", "session has no live workload");
        }
        admitReload(entry, deps.reloadLimitPerMinute, "reloads");
        // Omitting `app` reloads every app in the session.
        const requested = req.query.app?.trim();
        if (requested && !entry.apps.has(requested)) {
          throw new SessionRefusal(404, "unknown_app", `session runs no app named '${requested}'`);
        }
        const targets = requested ? [requested] : [...entry.apps.keys()];
        for (const name of targets) entry.attribution?.expect(name, "manual");
        for (const name of targets) await workload.reload(name);
        reply.code(202).send({ reloaded: targets });
      },
    );
  };
}

/**
 * The session a request may act on: its credentials must own it. A missing
 * credential is `401 session_auth_required`; a session that does not exist and
 * one another owner holds are the same `404`, so an id reveals nothing.
 */
async function ownedSession(
  deps: SessionsRouteDeps,
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<SessionEntry | undefined> {
  const resolved = await deps.resolveCaller(req);
  if ("refusal" in resolved) {
    refuse(reply, resolved.refusal);
    return undefined;
  }
  if (resolved.caller.kind === "anonymous") {
    authRequired(deps, reply, "this route takes the session's credentials");
    return undefined;
  }
  const entry = deps.registry.get(req.params.id);
  if (!entry || !ownsSession(resolved.caller.owner, entry.record.owner)) {
    reply.code(404).send({ error: "not_found", message: `no session '${req.params.id}'` });
    return undefined;
  }
  return entry;
}

/**
 * The identity a request carries, for a route only an identity may use. No
 * credential is `401 session_auth_required`; a resume secret is
 * `403 identity_required`, since it names one session rather than an owner.
 */
async function identityOwner(
  deps: SessionsRouteDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  what: string,
): Promise<SessionOwner | undefined> {
  const resolved = await deps.resolveCaller(req);
  if ("refusal" in resolved) {
    refuse(reply, resolved.refusal);
    return undefined;
  }
  if (resolved.caller.kind === "anonymous") {
    authRequired(deps, reply, `${what} takes an identity`);
    return undefined;
  }
  if (resolved.caller.owner.kind !== "identity") {
    reply.code(403).send({
      error: "identity_required",
      message: deps.authChallenge
        ? `${what} takes an identity — \`Authorization: DPoP <access token>\` with a \`DPoP\` proof — ` +
          "not a resume secret"
        : `${what} takes an identity, and this runner accepts none (see /v1/capabilities)`,
    });
    return undefined;
  }
  return resolved.caller.owner;
}

function authRequired(deps: SessionsRouteDeps, reply: FastifyReply, what: string): void {
  if (deps.authChallenge) reply.header("www-authenticate", deps.authChallenge);
  reply.code(401).send({
    error: "session_auth_required",
    message: deps.authChallenge
      ? `${what}: \`Authorization: Bearer <resume secret>\`, or \`Authorization: DPoP <access token>\` ` +
        "with a `DPoP` proof"
      : `${what}: \`Authorization: Bearer <resume secret>\``,
  });
}

function refuse(
  reply: FastifyReply,
  refusal: { status: number; error: string; message: string; headers?: Record<string, string> },
): void {
  if (refusal.headers) reply.headers(refusal.headers);
  reply.code(refusal.status).send({ error: refusal.error, message: refusal.message });
}

/** Terms are enforced server-side: a client that skips the editor gate still
 *  cannot create a session without acknowledging the current version. */
function acceptsTerms(req: FastifyRequest, reply: FastifyReply, terms: RunnerTerms | undefined): boolean {
  if (!terms) return true;
  const raw = req.headers[ACCEPTED_TERMS_HEADER];
  const accepted = Array.isArray(raw) ? raw[0] : raw;
  if (accepted !== terms.version) {
    reply.code(428).send({ error: "terms_required", terms });
    return false;
  }
  return true;
}

function gateConfig(deps: SessionsRouteDeps, config: SessionConfig, telo: boolean): void {
  const message = deps.validateConfig?.(config, { telo });
  if (message) throw new SessionRefusal(400, "invalid_config", message);
}

function liveWorkspace(entry: SessionEntry) {
  if (entry.status.kind !== "running" || !entry.workload) {
    throw new SessionRefusal(409, "not_running", "session has no live workspace");
  }
  return entry.workload.workspace;
}

function checkedPath(path: string): void {
  try {
    normalizeBundlePath(path);
  } catch (err) {
    if (err instanceof BundlePathError) throw new SessionRefusal(400, "invalid_path", err.message);
    throw err;
  }
}

/** Sliding one-minute window. Recorded only on an ADMITTED request, so a client
 *  hammering a rate-limited endpoint cannot extend its own penalty. */
function admitReload(entry: SessionEntry, limitPerMinute: number, what: string): void {
  const now = Date.now();
  entry.reloads = entry.reloads.filter((t) => now - t < 60_000);
  if (entry.reloads.length >= limitPerMinute) {
    throw new SessionRefusal(
      429,
      "reload_rate_limited",
      `more than ${limitPerMinute} ${what} in the last minute`,
    );
  }
  entry.reloads.push(now);
}

function sessionDocument(entry: SessionEntry) {
  const record = entry.record;
  return {
    sessionId: entry.sessionId,
    workspace: record.workspace,
    status: entry.status,
    agent: record.agent,
    config: record.config,
    apps: record.apps.map((a) => {
      const channel = entry.apps.get(a.name);
      return {
        name: a.name,
        entryRelativePath: a.entryRelativePath,
        ports: channel?.ports ?? a.ports,
        ...(a.telo !== undefined ? { telo: a.telo } : {}),
        state: channel?.state ?? "pending",
        ...(channel?.run ? { runId: channel.run.runId, io: channel.run.io } : {}),
        generation: channel?.generation ?? 0,
      };
    }),
    createdAt: record.createdAt.toISOString(),
    lastActiveAt: record.lastActiveAt.toISOString(),
    suspendedAt: record.suspendedAt?.toISOString() ?? null,
  };
}

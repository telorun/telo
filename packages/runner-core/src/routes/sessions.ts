import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";

import type { BackendAppSpec, RunnerBackend } from "../backend.js";
import type { ResolvedRunnerApp, WatchSessionConfig } from "../config.js";
import {
  DEFAULT_APP_NAME,
  type IoMode,
  type PortMapping,
  type RunnerTerms,
  type SessionAppSpec,
  type SessionConfig,
  type StartSessionRequest,
  type WorkspaceChangeSet,
} from "../contract.js";
import { BundlePathError, normalizeBundlePath } from "../session/bundle-path.js";
import type { SessionEntry, SessionRegistry } from "../session/registry.js";
import { enforceTerms, launchWorkload, portsSchema, startWorkloadSession } from "./session-start.js";
import { streamSessionEvents } from "../sse/channel.js";

/** The part of the operator's watch settings this route enforces. A projection
 *  of `WatchSessionConfig` rather than a second shape, so the two cannot
 *  disagree about what a field means. */
export type WatchConfig = Pick<
  WatchSessionConfig,
  "enabled" | "maxSessions" | "reloadLimitPerMinute"
>;

export interface SessionsRouteDeps {
  backend: RunnerBackend;
  registry: SessionRegistry;
  corsOrigins: string[] | "*";
  /** When set, a session may only start if the client acknowledges this exact
   *  terms version via the `x-telo-accepted-terms` header. */
  terms?: RunnerTerms;
  /** Backend-supplied config gate. Returns an error message to reject the
   *  request with `400 invalid_config`, or `undefined` to accept. The runner is
   *  the source of truth, so this re-checks what `/v1/capabilities` advertises
   *  (e.g. an `image` allowlist) against a client that skipped the editor. */
  validateConfig?: (config: SessionConfig) => string | undefined;
  /** The operator catalog a session's `agent` is resolved against — the same
   *  catalog `POST /v1/apps/:name/sessions` uses, because a co-resident agent IS
   *  an operator-predefined application, just one sharing a pod. */
  apps?: Record<string, ResolvedRunnerApp>;
  watch: WatchConfig;
}

const appsSchema = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    required: ["name", "entryRelativePath"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 63 },
      entryRelativePath: { type: "string", minLength: 1 },
      ports: portsSchema,
      io: { type: "string", enum: ["tty", "streams"] },
    },
  },
} as const;

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
      },
    },
    inspect: { type: "boolean" },
    mode: { type: "string", enum: ["run", "watch"] },
    agent: { type: "string", minLength: 1 },
    apps: appsSchema,
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

/** A DNS label — the app name appears in a container name and in every run
 *  event, so it has to survive both. */
const APP_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Names a session's own containers already use. The docker backend keys every
 *  container of a session in one map, so an app called `workspace` would
 *  overwrite the workspace handle — leaking the real container, since
 *  `AutoRemove` only fires on stop. Reserved in core so one rule covers both
 *  backends rather than k8s being safe only by its `app-` prefix. */
const RESERVED_APP_NAMES = new Set(["workspace", "agent"]);

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
        mode: entry.mode,
        agent: entry.agent,
        apps: [...entry.apps.values()].map((a) => ({
          name: a.name,
          io: a.io,
          generation: a.generation,
          ports: a.ports,
        })),
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

    // ---- Workspace surface -------------------------------------------------
    // Every write from OUTSIDE the pod goes through these; the co-resident agent
    // writes the same volume directly with its own filesystem tools. Two writers,
    // N watchers, one directory — which is what replaces three delivery paths.

    app.get<{ Params: { id: string } }>("/v1/sessions/:id/workspace", async (req, reply) => {
      const ws = resolveWorkspace(deps, req.params.id, reply);
      if (!ws) return;
      reply.send(await ws.tree());
    });

    app.post<{ Params: { id: string }; Body: WorkspaceChangeSet }>(
      "/v1/sessions/:id/workspace",
      { schema: { body: changeSetSchema } },
      async (req, reply) => {
        const entry = requireWatchSession(deps, req.params.id, reply);
        if (!entry) return;
        // The reload budget belongs on the route that CAUSES reloads. Guarding
        // `POST /reload` alone left the editor's save path — one write per save,
        // each triggering a kernel reload — unbounded, which is the shape the
        // budget exists to prevent.
        if (!admitReload(entry, deps.watch.reloadLimitPerMinute)) {
          reply.code(429).send({
            error: "reload_rate_limited",
            message: `more than ${deps.watch.reloadLimitPerMinute} workspace writes in the last minute`,
          });
          return;
        }
        const ws = entry.session?.workspace;
        if (!ws) {
          reply.code(409).send({ error: "not_running", message: "session has no live workspace" });
          return;
        }
        try {
          for (const w of req.body.write ?? []) normalizeBundlePath(w.path);
          for (const p of req.body.delete ?? []) normalizeBundlePath(p);
        } catch (err) {
          if (err instanceof BundlePathError) {
            reply.code(400).send({ error: "invalid_path", message: err.message });
            return;
          }
          throw err;
        }
        reply.send(await ws.apply(req.body));
      },
    );

    app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
      "/v1/sessions/:id/workspace/file",
      async (req, reply) => {
        const ws = resolveWorkspace(deps, req.params.id, reply);
        if (!ws) return;
        const path = req.query.path?.trim();
        if (!path) {
          reply.code(400).send({ error: "invalid_path", message: "?path= is required" });
          return;
        }
        try {
          normalizeBundlePath(path);
        } catch (err) {
          if (err instanceof BundlePathError) {
            reply.code(400).send({ error: "invalid_path", message: err.message });
            return;
          }
          throw err;
        }
        reply.send(await ws.readFile(path));
      },
    );

    // `--watch` reloads on change, and pressing Run again after a one-shot app
    // completed is not a change. This touches the named app's entry manifest
    // through the same write path everything else uses — no signalling into the
    // container, no shared PID namespace, no `exec`.
    app.post<{ Params: { id: string }; Querystring: { app?: string } }>(
      "/v1/sessions/:id/reload",
      async (req, reply) => {
        const entry = requireWatchSession(deps, req.params.id, reply);
        if (!entry) return;
        const session = entry.session;
        if (!session?.reload) {
          reply.code(409).send({ error: "not_running", message: "session has no live workload" });
          return;
        }
        if (!admitReload(entry, deps.watch.reloadLimitPerMinute)) {
          reply.code(429).send({
            error: "reload_rate_limited",
            message: `more than ${deps.watch.reloadLimitPerMinute} reloads in the last minute`,
          });
          return;
        }
        // Omitting `app` reloads every app in the session.
        const requested = req.query.app?.trim();
        if (requested && !entry.apps.has(requested)) {
          reply.code(404).send({
            error: "unknown_app",
            message: `session runs no app named '${requested}'`,
          });
          return;
        }
        const targets = requested ? [requested] : [...entry.apps.keys()];
        for (const name of targets) entry.attribution?.expect(name, "manual");
        for (const name of targets) await session.reload(name);
        reply.code(202).send({ reloaded: targets });
      },
    );

    // A pod's container list is fixed at creation, so changing WHICH apps run
    // costs a checkpoint and a pod recreate — the suspend/resume path, reused.
    // Editing a file stays free; this is the rare action that pays.
    app.put<{ Params: { id: string }; Body: { apps: SessionAppSpec[] } }>(
      "/v1/sessions/:id/apps",
      { schema: { body: { type: "object", required: ["apps"], properties: { apps: appsSchema } } } },
      async (req, reply) => {
        const entry = requireWatchSession(deps, req.params.id, reply);
        if (!entry) return;
        const session = entry.session;
        if (!session?.setApps) {
          reply.code(409).send({ error: "not_running", message: "session has no live workload" });
          return;
        }
        const resolved = resolveApps(req.body.apps, undefined, []);
        if ("error" in resolved) {
          reply.code(400).send(resolved.error);
          return;
        }
        // Channels for the NEW apps go in first — the backend starts emitting
        // output as soon as a container is up, and a push to an unknown app is
        // silently dropped. Removals wait until the backend has succeeded, so a
        // failed recreate leaves the session describing what is still running.
        for (const spec of resolved.apps) {
          if (!entry.apps.has(spec.name)) {
            deps.registry.addApp(entry, { name: spec.name, io: spec.io, ports: spec.ports });
          }
        }
        entry.attribution?.expectAll("resume");
        try {
          await session.setApps(resolved.apps);
        } catch (err) {
          // `setApps` recreates the workload, so rejecting is a normal outcome
          // (pod create, start deadline, workspace never ready). Undo the
          // channels we added and fail the session rather than leaving it
          // `running` with nothing behind it.
          for (const spec of resolved.apps) {
            if (!entry.launch?.apps.some((a) => a.name === spec.name)) {
              entry.apps.delete(spec.name);
            }
          }
          const message = err instanceof Error ? err.message : String(err);
          deps.registry.emit(entry.sessionId, {
            type: "status",
            status: { kind: "failed", message: `changing the app set failed: ${message}` },
          });
          reply.code(500).send({ error: "set_apps_failed", message });
          return;
        }
        for (const name of [...entry.apps.keys()]) {
          if (!resolved.apps.some((a) => a.name === name)) entry.apps.delete(name);
        }
        // The retained launch is what `resume` rebuilds from. Leaving it stale
        // would rebuild the ORIGINAL app set under a registry holding the new
        // one: output for the running containers dropped, and a session document
        // listing apps that are not running.
        if (entry.launch) entry.launch = { ...entry.launch, apps: resolved.apps };
        reply.code(202).send({ apps: resolved.apps.map((a) => a.name) });
      },
    );

    // A suspended session is best-effort by design: the checkpoint lives in the
    // runner's memory, so a restart loses it and this answers 404. The editor
    // holds the authoritative workspace and re-seeds from its own copy — which
    // is a requirement ON the editor, not an observation about it.
    app.post<{ Params: { id: string } }>("/v1/sessions/:id/resume", async (req, reply) => {
      const entry = deps.registry.get(req.params.id);
      if (!entry || entry.status.kind !== "suspended") {
        reply.code(404).send({
          error: "not_suspended",
          message: `session '${req.params.id}' is not suspended`,
        });
        return;
      }
      const checkpoint = entry.checkpoint;
      const launch = entry.launch;
      if (!checkpoint || !launch) {
        reply.code(409).send({
          error: "no_checkpoint",
          message: "session was suspended before a workspace checkpoint was taken",
        });
        return;
      }
      entry.attribution?.expectAll("resume");
      entry.session = null;
      deps.registry.emit(entry.sessionId, { type: "status", status: { kind: "starting" } });
      // The checkpoint IS the bundle for the new pod — a cold pod re-downloads
      // its module closure, and only the workspace is checkpointed, never the
      // cache.
      launchWorkload(
        app,
        deps,
        {
          ...launch,
          bundle: {
            entryRelativePath: launch.apps[0]?.entryRelativePath ?? "telo.yaml",
            files: checkpoint.files.map((f) => ({
              relativePath: f.path,
              contents: f.content,
              encoding: f.encoding,
            })),
          },
        },
        entry,
      );
      reply.code(202).send({ sessionId: entry.sessionId });
    });
  };
}

/** Reject anything but a live watch session, with the reason. */
function requireWatchSession(
  deps: SessionsRouteDeps,
  sessionId: string,
  reply: FastifyReply,
): SessionEntry | undefined {
  const entry = deps.registry.get(sessionId);
  if (!entry) {
    reply.code(404).send({ error: "not_found", message: `session '${sessionId}' not in registry` });
    return undefined;
  }
  if (entry.mode !== "watch") {
    reply.code(409).send({
      error: "not_a_watch_session",
      message: "this surface exists only on a watch session",
    });
    return undefined;
  }
  return entry;
}

function resolveWorkspace(
  deps: SessionsRouteDeps,
  sessionId: string,
  reply: FastifyReply,
): NonNullable<SessionEntry["session"]>["workspace"] | undefined {
  const entry = requireWatchSession(deps, sessionId, reply);
  if (!entry) return undefined;
  const workspace = entry.session?.workspace;
  if (!workspace) {
    reply.code(409).send({ error: "not_running", message: "session has no live workspace" });
    return undefined;
  }
  return workspace;
}

/** Sliding one-minute window. Recorded only on an ADMITTED reload, so a client
 *  hammering a rate-limited endpoint cannot extend its own penalty. */
function admitReload(entry: SessionEntry, limitPerMinute: number): boolean {
  const now = Date.now();
  entry.reloads = entry.reloads.filter((t) => now - t < 60_000);
  if (entry.reloads.length >= limitPerMinute) return false;
  entry.reloads.push(now);
  return true;
}

type ResolvedApps = { apps: BackendAppSpec[] } | { error: { error: string; message: string } };

/**
 * Normalize the declared app set. Omitted, it defaults to a single app named
 * `app` taking the bundle's own entry and the request's `ports` — so a
 * single-app session is written exactly as it is today.
 *
 * Ports are unique across the WHOLE session, not per app: session hosts are
 * `<port>-<sessionId>.<base-domain>`, a single label, so two apps both listening
 * on 3000 collide with nothing to distinguish them. Rejecting at create is a
 * better outcome than a URL that silently reaches the wrong app — the user
 * controls both manifests.
 */
function resolveApps(
  declared: SessionAppSpec[] | undefined,
  bundleEntry: string | undefined,
  fallbackPorts: PortMapping[],
): ResolvedApps {
  const specs: SessionAppSpec[] = declared ?? [
    {
      name: DEFAULT_APP_NAME,
      entryRelativePath: bundleEntry ?? "",
      ports: fallbackPorts,
    },
  ];

  const seenNames = new Set<string>();
  const portOwner = new Map<string, string>();
  const apps: BackendAppSpec[] = [];

  for (const spec of specs) {
    if (!APP_NAME_PATTERN.test(spec.name)) {
      return {
        error: {
          error: "invalid_app_name",
          message: `app name '${spec.name}' must be a DNS label (lowercase alphanumeric and '-')`,
        },
      };
    }
    if (RESERVED_APP_NAMES.has(spec.name)) {
      return {
        error: {
          error: "reserved_app_name",
          message: `app name '${spec.name}' is reserved — a session's own containers use it`,
        },
      };
    }
    if (seenNames.has(spec.name)) {
      return {
        error: { error: "duplicate_app_name", message: `app '${spec.name}' is declared twice` },
      };
    }
    seenNames.add(spec.name);

    let entryRelativePath: string;
    try {
      entryRelativePath = normalizeBundlePath(spec.entryRelativePath);
    } catch (err) {
      if (err instanceof BundlePathError) {
        return { error: { error: "invalid_bundle", message: err.message } };
      }
      throw err;
    }

    const ports = spec.ports ?? [];
    for (const port of ports) {
      const key = `${port.protocol}/${port.port}`;
      const owner = portOwner.get(key);
      if (owner) {
        return {
          error: {
            error: "port_conflict",
            message: `apps '${owner}' and '${spec.name}' both declare ${port.protocol} port ${port.port}; session hosts carry no app name, so the two would be indistinguishable`,
          },
        };
      }
      portOwner.set(key, spec.name);
    }

    apps.push({
      name: spec.name,
      entryRelativePath,
      ports,
      io: (spec.io ?? "tty") as IoMode,
    });
  }

  return { apps };
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

  const mode = body.mode ?? "run";
  if (mode === "watch" && !deps.watch.enabled) {
    reply.code(400).send({
      error: "watch_disabled",
      message: "this runner does not offer watch sessions (see /v1/capabilities)",
    });
    return;
  }

  // An agent with nothing watching its writes is a silent no-op, so the pairing
  // is enforced rather than tolerated.
  let agent: ResolvedRunnerApp | undefined;
  if (body.agent) {
    if (mode !== "watch") {
      reply.code(400).send({
        error: "agent_requires_watch",
        message: "`agent` requires `mode: \"watch\"` — nothing would observe the agent's writes",
      });
      return;
    }
    agent = deps.apps?.[body.agent];
    if (!agent) {
      const offered = Object.keys(deps.apps ?? {});
      reply.code(400).send({
        error: "unknown_agent",
        message:
          `agent '${body.agent}' is not offered by this runner` +
          (offered.length > 0 ? ` — offered: ${offered.join(", ")}` : ""),
      });
      return;
    }
    // An agent nothing can reach is the same silent no-op as an agent nothing
    // watches, one layer down: it would write the volume and never be asked to.
    // The port is the operator's to declare, so the failure names their config
    // rather than anything the caller can change.
    if (agent.port === undefined) {
      reply.code(400).send({
        error: "agent_port_undeclared",
        message:
          `agent '${body.agent}' declares no port, so this runner cannot route it — ` +
          `set RUNNER_APPS.${body.agent}.port to the port its image listens on`,
      });
      return;
    }
  }

  if (mode === "watch") {
    // A suspended session holds no pod, so it does not consume the resource the
    // ceiling exists to bound — and it is reclaimable, so counting it would let
    // a few visitors who left hold every slot for the whole suspended TTL.
    const live = deps.registry
      .list()
      .filter(
        (e) => e.mode === "watch" && e.exitedAt === null && e.status.kind !== "suspended",
      ).length;
    if (live >= deps.watch.maxSessions) {
      reply.code(409).send({
        error: "too_many_watch_sessions",
        message: `runner is at its configured max of ${deps.watch.maxSessions} concurrent watch sessions`,
      });
      return;
    }
  }

  const resolved = resolveApps(body.apps, entryRelative, body.ports ?? []);
  if ("error" in resolved) {
    reply.code(400).send(resolved.error);
    return;
  }

  // The agent's port shares the session's port space with the apps' — on
  // kubernetes literally (the pod's containers share one network namespace, so
  // two of them cannot bind the same port at all), and on docker because a
  // no-proxy runner publishes both to the same host.
  //
  // The MANIFEST WINS. A client asks for an agent as a convenience, and on the
  // editor's path does so on every run without the user choosing; refusing the
  // whole session would mean an application that declares the operator's agent
  // port — 8080, which applications routinely declare — could not be run at all,
  // for a reason naming a container the user never requested and cannot decline.
  // So the agent is dropped and the session starts without one, reported rather
  // than silent: a client sees no `agent` endpoint on `running`, and the notice
  // below says why.
  let agentNotice: string | undefined;
  if (agent?.port !== undefined) {
    const clash = resolved.apps.find((a) =>
      a.ports.some((p) => p.protocol === "tcp" && p.port === agent!.port),
    );
    if (clash) {
      agentNotice =
        `co-resident agent '${agent.name}' was not started: it listens on tcp port ${agent.port}, ` +
        `which app '${clash.name}' declares`;
      agent = undefined;
    }
  }

  return startWorkloadSession(
    app,
    deps,
    {
      bundle: body.bundle,
      env: body.env,
      config: body.config,
      selfContained: false,
      // A watch session always runs with the kernel debug stream on: that stream
      // is the only place run outcomes exist, and parsing the merged PTY output
      // would not be a contract.
      inspect: mode === "watch" ? true : (body.inspect ?? false),
      mode,
      apps: resolved.apps,
      agent,
    },
    reply,
    agentNotice ? [agentNotice] : undefined,
  );
}

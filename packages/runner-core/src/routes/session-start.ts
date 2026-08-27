import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { isEventFrame } from "@telorun/debug-wire";
import type { RunnerBackend, WorkloadLaunch } from "../backend.js";
import { RunProjection } from "../debug/run-projection.js";
import {
  ACCEPTED_TERMS_HEADER,
  SessionStartError,
  type RunnerTerms,
} from "../contract.js";
import { generateSessionId } from "../session/session-id.js";
import {
  SessionLimitError,
  type SessionEntry,
  type SessionRegistry,
} from "../session/registry.js";

/** JSON Schema for the `ports` body field, shared by every session-creating
 *  route so bundle and app sessions validate port mappings identically. */
export const portsSchema = {
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

/**
 * Terms enforcement shared by every session-creating route — the server is the
 * source of truth, so a client that skips the editor gate still can't start a
 * workload without acknowledging the current terms version. Sends the 428 and
 * returns false when the gate is closed.
 */
export function enforceTerms(
  req: FastifyRequest,
  reply: FastifyReply,
  terms: RunnerTerms | undefined,
): boolean {
  if (!terms) return true;
  const raw = req.headers[ACCEPTED_TERMS_HEADER];
  const accepted = Array.isArray(raw) ? raw[0] : raw;
  if (accepted !== terms.version) {
    reply.code(428).send({ error: "terms_required", terms });
    return false;
  }
  return true;
}

/** Dependencies the shared session-creation leaf needs, independent of which
 *  route drives it. Both `SessionsRouteDeps` and `AppsRouteDeps` satisfy it. */
export interface WorkloadStartDeps {
  backend: RunnerBackend;
  registry: SessionRegistry;
  /** The runner's own default registry URL, surfaced to the workload as
   *  TELO_REGISTRY_URL when the request doesn't override it. */
  defaultRegistryUrl?: string;
}

export type WorkloadStartArgs = WorkloadLaunch;

/**
 * The session-creation leaf shared by `POST /v1/sessions` (bundle sessions) and
 * `POST /v1/apps/:name/sessions` (operator-predefined apps): registers the
 * session, responds 201 with the shared `/v1/sessions/:id/events` stream URL,
 * and starts the workload in the background. Whatever door a session was
 * created through, everything after creation lives in the one session
 * collection (status, DELETE, events, io).
 */
export async function startWorkloadSession(
  app: FastifyInstance,
  deps: WorkloadStartDeps,
  args: WorkloadStartArgs,
  reply: FastifyReply,
): Promise<void> {
  const sessionId = generateSessionId();

  let entry: ReturnType<SessionRegistry["register"]>;
  try {
    entry = deps.registry.register({
      sessionId,
      mode: args.mode,
      agent: args.agent?.name,
      apps: args.apps.map((a) => ({ name: a.name, io: a.io, ports: a.ports })),
    });
  } catch (err) {
    if (err instanceof SessionLimitError) {
      reply.code(409).send({ error: "too_many_sessions", message: err.message });
      return;
    }
    throw err;
  }

  // Surface a TELO_REGISTRY_URL to the workload so the telo CLI inside picks
  // it up. Precedence: explicit env value > config.registryUrl (per-request
  // override) > runner's own default. Trim client-supplied URLs so stray
  // whitespace from an editor input doesn't flow into the workload.
  const configRegistryUrl = args.config.registryUrl?.trim() || undefined;
  const registryUrl = configRegistryUrl ?? deps.defaultRegistryUrl;
  const sessionEnv = withoutCacheOverride(
    registryUrl && !("TELO_REGISTRY_URL" in args.env)
      ? { ...args.env, TELO_REGISTRY_URL: registryUrl }
      : args.env,
  );

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

  // Every app's first generation is attributed to the session coming up; a
  // reload after that is a watch reload unless a route says otherwise.
  const projection = new RunProjection(deps.registry, sessionId);
  projection.expectAll("initial");
  // Parked on the entry so the reload / resume routes can attribute the
  // generation they are about to cause.
  entry.attribution = projection;

  const launch: WorkloadLaunch = { ...args, env: sessionEnv };
  entry.launch = launch;
  launchWorkload(app, deps, launch, entry);
}

/**
 * Wire a backend workload to an EXISTING registry entry and start it in the
 * background. Shared by session creation and by `resume`, which builds a fresh
 * pod from the checkpoint under the same session id — the callback wiring is the
 * contract's, so a second copy of it would be a second place run outcomes,
 * output routing and the credential boundary could drift.
 */
export function launchWorkload(
  app: FastifyInstance,
  deps: WorkloadStartDeps,
  args: WorkloadStartArgs,
  entry: SessionEntry,
): void {
  const sessionId = entry.sessionId;
  const projection = entry.attribution;

  deps.backend
    .start({
      sessionId,
      bundle: args.bundle,
      env: args.env,
      config: args.config,
      selfContained: args.selfContained,
      inspect: args.inspect,
      mode: args.mode,
      apps: args.apps,
      agent: args.agent,
      onStatus: (status) => deps.registry.emit(sessionId, { type: "status", status }),
      onProgress: (phase, message, done, app) =>
        deps.registry.emit(sessionId, { type: "progress", app, phase, message, done }),
      onOutput: (app, chunk, stream) => deps.registry.pushBytes(sessionId, app, chunk, stream),
      // Relay only kernel *event* frames to the client. stdout/stderr already
      // arrive over the byte channel (onOutput), so forwarding log frames would
      // double the traffic and let log spam evict lifecycle events from the
      // byte-capped replay buffer. The editor discards relayed logs anyway.
      //
      // The projection sees EVERY frame, including the ones not relayed — run
      // outcomes are derived from lifecycle events, not from what a client
      // happens to be shown.
      onDebug: (appName, frame) => {
        projection?.frame(appName, frame);
        if (isEventFrame(frame)) {
          deps.registry.emit(sessionId, { type: "debug", app: appName, frame });
        }
      },
      // A watch session's app dying is a RUN outcome, not a session status: the
      // rest of the session is still up, and the next edit starts the next
      // generation. The projection owns generation identity, so the ending goes
      // through it rather than being emitted directly.
      onRunEnded: (appName, outcome) =>
        projection?.endGeneration(appName, outcome) ??
        deps.registry.finishGeneration(sessionId, appName, {
          phase: "failed",
          reason: outcome.reason ?? "workload ended",
        }),
      onReachability: (app, port, state) =>
        deps.registry.emit(sessionId, { type: "reachability", app, port, state }),
      onEndpoints: (appName, change) => {
        // The registry's own channel is what `GET /v1/sessions/:id` reports, so
        // the delta has to land there too — otherwise the session document keeps
        // describing the port set the session STARTED with, forever.
        const channel = entry.apps.get(appName);
        if (channel) {
          const removed = new Set(
            (change.removed ?? []).map((e) => `${e.protocol}/${e.port}`),
          );
          channel.ports = [
            ...channel.ports.filter((p) => !removed.has(`${p.protocol}/${p.port}`)),
            ...(change.added ?? []).map((e) => ({ port: e.port, protocol: e.protocol })),
          ];
        }
        deps.registry.emit(sessionId, { type: "endpoints", app: appName, ...change });
      },
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

/**
 * Drop a client-supplied `TELO_CACHE_DIR`.
 *
 * It OUTRANKS the `telo-workspace.yaml` marker the session seeds at its
 * workspace root, so a client that sets it silently gives every app its own
 * module cache — the exact thing the marker exists to prevent. Where a cache
 * root is genuinely needed (the workspace container, whose manifest lives
 * outside the workspace) the backend sets it itself.
 */
function withoutCacheOverride(env: Record<string, string>): Record<string, string> {
  if (!("TELO_CACHE_DIR" in env)) return env;
  const rest = { ...env };
  delete rest.TELO_CACHE_DIR;
  return rest;
}

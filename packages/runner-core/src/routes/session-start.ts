import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { isEventFrame } from "@telorun/debug-wire";
import type { RunnerBackend } from "../backend.js";
import {
  ACCEPTED_TERMS_HEADER,
  SessionStartError,
  type PortMapping,
  type RunBundle,
  type RunnerTerms,
  type SessionConfig,
} from "../contract.js";
import { generateSessionId } from "../session/session-id.js";
import { SessionLimitError, type SessionRegistry } from "../session/registry.js";

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

export interface WorkloadStartArgs {
  bundle: RunBundle;
  entryRelativePath: string;
  env: Record<string, string>;
  ports: PortMapping[];
  config: SessionConfig;
  selfContained: boolean;
  inspect: boolean;
}

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
    entry = deps.registry.register({ sessionId });
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
  const sessionEnv =
    registryUrl && !("TELO_REGISTRY_URL" in args.env)
      ? { ...args.env, TELO_REGISTRY_URL: registryUrl }
      : args.env;

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
      bundle: args.bundle,
      entryRelativePath: args.entryRelativePath,
      env: sessionEnv,
      ports: args.ports,
      config: args.config,
      selfContained: args.selfContained,
      inspect: args.inspect,
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

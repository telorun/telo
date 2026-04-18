import type { FastifyReply, FastifyRequest } from "fastify";

import { isTerminal, SessionEvictedError, type SessionRegistry } from "../session/registry.js";
import type { BufferedEvent } from "../session/ring-buffer.js";

const HEARTBEAT_MS = 20_000;

export interface SseStreamArgs {
  registry: SessionRegistry;
  req: FastifyRequest;
  reply: FastifyReply;
  sessionId: string;
  corsOrigins: string[] | "*";
}

export async function streamSessionEvents(args: SseStreamArgs): Promise<void> {
  const { registry, req, reply, sessionId, corsOrigins } = args;
  const entry = registry.get(sessionId);
  if (!entry) {
    reply.code(404).send({ error: "not_found", message: `session '${sessionId}' not in registry` });
    return;
  }

  const lastEventId = resolveLastEventId(req);
  const raw = reply.raw;

  // @fastify/cors adds Access-Control-Allow-Origin via an onSend hook, which
  // never fires for this route because we bypass reply and write directly to
  // reply.raw. Inject the CORS headers manually from our config.
  const headers: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
  const allowOrigin = resolveAllowOrigin(corsOrigins, req.headers.origin);
  if (allowOrigin) {
    headers["access-control-allow-origin"] = allowOrigin;
    headers["vary"] = "Origin";
  }

  raw.writeHead(200, headers);

  // Replay any buffered history > lastEventId. `hasGap` triggers a synthetic
  // gap marker so the client knows earlier output was evicted before we could
  // deliver it.
  const { entries, hasGap } = entry.buffer.replay(lastEventId);
  if (hasGap) {
    writeFrame(raw, "gap", { reason: "buffer_evicted" });
  }
  for (const buffered of entries) {
    writeBufferedEvent(raw, buffered);
  }

  // If the session already reached a terminal status before the client hit
  // /events, replay has delivered the terminal status frame and we're done.
  if (isTerminal(entry.status)) {
    raw.end();
    return;
  }

  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let closed = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (unsubscribe) unsubscribe();
    if (!raw.writableEnded) raw.end();
  };

  heartbeat = setInterval(() => {
    if (!raw.writableEnded) raw.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    unsubscribe = registry.subscribe(sessionId, (buffered) => {
      writeBufferedEvent(raw, buffered);
      if (buffered.event.type === "status" && isTerminal(buffered.event.status)) {
        cleanup();
      }
    });
  } catch (err) {
    if (err instanceof SessionEvictedError) {
      cleanup();
      return;
    }
    throw err;
  }

  req.raw.on("close", cleanup);
  req.raw.on("end", cleanup);

  // Keep the response alive — Fastify's handler must not return until the
  // stream closes, otherwise it sends a default end.
  await new Promise<void>((resolve) => {
    raw.on("close", resolve);
    raw.on("finish", resolve);
  });
}

function resolveLastEventId(req: FastifyRequest): number {
  // Spec: header wins over query. EventSource sets the header on native
  // auto-reconnect; the query param is for fresh instances (tab reload) where
  // sse-client.ts passes the persisted id explicitly.
  const header = req.headers["last-event-id"];
  const fromHeader = parseId(Array.isArray(header) ? header[0] : header);
  if (fromHeader !== null) return fromHeader;

  const query = req.query as { lastEventId?: string } | undefined;
  const fromQuery = parseId(query?.lastEventId);
  return fromQuery ?? 0;
}

function resolveAllowOrigin(
  corsOrigins: string[] | "*",
  requestOrigin: string | string[] | undefined,
): string | null {
  if (corsOrigins === "*") return "*";
  const origin = Array.isArray(requestOrigin) ? requestOrigin[0] : requestOrigin;
  if (!origin) return null;
  return corsOrigins.includes(origin) ? origin : null;
}

function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  // `Last-Event-ID: 0` is valid per the SSE spec — it means "resume from the
  // beginning." Our ids start at 1, so replay(0) returns all buffered entries
  // and the hasGap check correctly compares against first-resident-id.
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function writeBufferedEvent(raw: NodeJS.WritableStream, buffered: BufferedEvent): void {
  writeFrame(raw, buffered.event.type, buffered.event, buffered.id);
}

function writeFrame(
  raw: NodeJS.WritableStream,
  event: string,
  data: unknown,
  id?: number,
): void {
  if (!("writable" in raw) || (raw as { writableEnded?: boolean }).writableEnded) return;
  let frame = "";
  if (id !== undefined) frame += `id: ${id}\n`;
  frame += `event: ${event}\n`;
  frame += `data: ${JSON.stringify(data)}\n\n`;
  raw.write(frame);
}

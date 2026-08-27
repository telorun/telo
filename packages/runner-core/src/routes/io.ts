import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";

import { isTerminal, type ByteStreamTag } from "../contract.js";
import type { BufferedBytes } from "../session/byte-ring-buffer.js";
import type { SessionRegistry } from "../session/registry.js";

export interface IoRouteDeps {
  registry: SessionRegistry;
  corsOrigins: string[] | "*";
}

const RESIZE_THROTTLE_MS = 50;
const SEQ_PREFIX_BYTES = 4;
const STREAM_TAG_BYTES = 1;
/** Wire codes for the per-frame stream tag. A tag rather than a labelled merged
 *  stream: under `io: "streams"` the transport really did separate stdout from
 *  stderr, and under `tty` it really did not. */
const STREAM_CODES: Record<ByteStreamTag, number> = { tty: 0, stdout: 1, stderr: 2 };
/** Upper bound on cols/rows accepted from the client. xterm + a fit addon
 *  produce values in the low thousands at extreme zoom; anything past this
 *  is either nonsense or a malicious client trying to feed
 *  `Number.MAX_SAFE_INTEGER` straight to the workload. */
const MAX_RESIZE_DIMENSION = 10_000;
const TERMINAL_DRAIN_INTERVAL_MS = 50;
const TERMINAL_DRAIN_MAX_MS = 2_000;

interface ControlFrame {
  type: string;
  cols?: number;
  rows?: number;
}

export function ioRoute(deps: IoRouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    app.get<{ Params: { id: string }; Querystring: IoQuery }>(
      "/v1/sessions/:id/io",
      { websocket: true },
      (socket, req) => handleIo(socket, req, deps),
    );
  };
}

interface IoQuery {
  lastSeq?: string;
  /** Which application's terminal to attach to. Required whenever the session
   *  runs more than one app — there is no defensible default among several. */
  app?: string;
}

function handleIo(
  socket: WebSocket,
  req: FastifyRequest<{ Params: { id: string }; Querystring: IoQuery }>,
  deps: IoRouteDeps,
): void {
  // Origin allowlist runs INSIDE the handler (post-handshake) rather than
  // in a preValidation hook. Reason: a 403 HTTP response on a failed
  // upgrade is invisible to browser WebSocket clients — they only ever
  // see close code 1006 (abnormal closure), which is indistinguishable
  // from a transient network failure and triggers exponential-backoff
  // reconnect loops forever. Closing with an application code (4403) the
  // browser CAN read lets the client fail fast.
  const origin = headerString(req.headers.origin);
  if (!isOriginAllowed(deps.corsOrigins, origin)) {
    closeWith(socket, 4403, "forbidden_origin");
    return;
  }

  const sessionId = req.params.id;
  const entry = deps.registry.get(sessionId);
  if (!entry) {
    closeWith(socket, 4404, "session not found");
    return;
  }

  // Resolve which app's terminal this attachment is for. An explicit name must
  // exist; an omitted one is only defensible on a single-app session.
  const requestedApp = req.query.app?.trim() || undefined;
  const channel = requestedApp
    ? entry.apps.get(requestedApp)
    : deps.registry.soleApp(entry);
  if (!channel) {
    closeWith(
      socket,
      4404,
      requestedApp
        ? `session runs no app named '${requestedApp}'`
        : `session runs ${entry.apps.size} apps — ?app= is required`,
    );
    return;
  }
  const appName = channel.name;

  const lastSeq = parseLastSeq(req.query.lastSeq);

  // Subscribe BEFORE snapshotting the replay buffer. This is load-bearing:
  // a `pushBytes` that fires between snapshot and subscribe would otherwise
  // be lost, with no way for either side to detect the gap. Bytes that
  // arrive during the deferred window are queued; once replay is sent, the
  // queue is drained (filtering anything seq-overlapping with replay) and
  // the handler switches to direct-send mode.
  let mode: "deferred" | "direct" = "deferred";
  const liveQueue: BufferedBytes[] = [];
  const unsubscribe = deps.registry.subscribeBytes(sessionId, appName, (buffered) => {
    if (socket.readyState !== socket.OPEN) return;
    if (mode === "deferred") {
      liveQueue.push(buffered);
    } else {
      sendBytesFrame(socket, buffered);
    }
  });

  const { entries, hasGap } = channel.byteBuffer.replay(lastSeq);

  // If the session is already terminal AND the byte buffer holds nothing
  // newer than what the client already saw, there's no live channel to
  // attach to — close 4410 so the client falls back to status-only display.
  if (isTerminal(entry.status) && entries.length === 0 && liveQueue.length === 0) {
    unsubscribe();
    closeWith(socket, 4410, "session terminal, nothing to replay");
    return;
  }

  // Confirm the resume point and which attachment this is, so a client knows
  // whether to offer resize before it sends one.
  sendJson(socket, { type: "seq", seq: lastSeq, app: appName, io: channel.io });
  if (hasGap) {
    sendJson(socket, { type: "gap", reason: "buffer_evicted" });
  }
  for (const buffered of entries) {
    sendBytesFrame(socket, buffered);
  }

  // Drain any live pushes that landed during the deferred window. Replay
  // entries are seq-monotonic, so anything queued with seq <= the last
  // replayed seq is a duplicate and must be dropped.
  const lastReplayedSeq =
    entries.length > 0 ? entries[entries.length - 1]!.seq : lastSeq;
  for (const buffered of liveQueue) {
    if (buffered.seq > lastReplayedSeq) {
      sendBytesFrame(socket, buffered);
    }
  }
  liveQueue.length = 0;
  // Synchronous flip — JS event loop guarantees no pushBytes can fire
  // between the drain loop above and this assignment, so the handler
  // doesn't need to lock.
  mode = "direct";

  let resizeTimer: NodeJS.Timeout | null = null;
  let pendingResize: { cols: number; rows: number } | null = null;
  const flushResize = (): void => {
    resizeTimer = null;
    const next = pendingResize;
    pendingResize = null;
    if (!next) return;
    // Session may have exited between schedule and flush; backends treat
    // resize on a gone workload as a no-op.
    entry.session?.resize(appName, next.cols, next.rows);
  };

  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      const session = entry.session;
      if (!session) return;
      const buf = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer);
      session.writeStdin(appName, buf);
      return;
    }
    const text = raw.toString();
    let parsed: ControlFrame;
    try {
      parsed = JSON.parse(text) as ControlFrame;
    } catch {
      return;
    }
    if (parsed.type === "resize") {
      // A resize is meaningless with no PTY — rejected rather than silently
      // dropped, so a client attached to a `streams` app learns it must not
      // wire its terminal's resize through.
      if (channel.io !== "tty") {
        sendJson(socket, { type: "error", error: "resize_unsupported", io: channel.io });
        return;
      }
      const cols = clampDimension(parsed.cols);
      const rows = clampDimension(parsed.rows);
      if (cols === null || rows === null) return;
      pendingResize = { cols, rows };
      if (resizeTimer === null) {
        resizeTimer = setTimeout(flushResize, RESIZE_THROTTLE_MS);
      }
    }
  });

  // Close the socket when the session reaches terminal status — replay
  // already covered the buffered bytes, no live bytes will arrive after
  // this, and clients can rely on socket close as their "stream finished"
  // signal alongside the SSE status frame. We poll `bufferedAmount` so
  // that an immediate close doesn't drop frames still queued on the
  // server-side socket.
  let drainTimer: NodeJS.Timeout | null = null;
  const drainAndClose = (deadline: number): void => {
    drainTimer = null;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount === 0 || Date.now() >= deadline) {
      try {
        socket.close(1000, "session terminal");
      } catch {
        /* already closed */
      }
      return;
    }
    drainTimer = setTimeout(() => drainAndClose(deadline), TERMINAL_DRAIN_INTERVAL_MS);
  };

  const unsubscribeStatus = deps.registry.subscribe(sessionId, (buffered) => {
    if (buffered.event.type !== "status") return;
    if (!isTerminal(entry.status)) return;
    if (drainTimer !== null) return;
    drainAndClose(Date.now() + TERMINAL_DRAIN_MAX_MS);
  });

  // Late-connect case: the session was already terminal at connect time
  // and had replayable bytes (so we didn't take the 4410 fast path). The
  // status subscription above will never fire — so the socket would
  // otherwise stay open forever after replay completes. Schedule directly.
  if (isTerminal(entry.status) && drainTimer === null) {
    drainAndClose(Date.now() + TERMINAL_DRAIN_MAX_MS);
  }

  // A byte-channel attachment counts as a live client: a session whose terminal
  // someone is watching is not idle, even with no SSE stream open.
  const releaseSubscriber = deps.registry.addSubscriber(sessionId);

  const cleanup = (): void => {
    releaseSubscriber();
    unsubscribe();
    unsubscribeStatus();
    if (resizeTimer) clearTimeout(resizeTimer);
    if (drainTimer) clearTimeout(drainTimer);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

/** Wire format for a binary frame: `[seq:4 BE][stream:1][payload:N]`. The 4-byte
 *  prefix lets the client de-sync detect — it knows the authoritative seq
 *  for every byte received, instead of inferring from frame count. Replay
 *  duplicates and reconnect resumes both lean on this. The stream byte says
 *  which source produced the payload; it is `tty` under a terminal attach and
 *  never asserts a split the transport did not make. */
function sendBytesFrame(socket: WebSocket, buffered: BufferedBytes): void {
  if (socket.readyState !== socket.OPEN) return;
  const prefix = Buffer.alloc(SEQ_PREFIX_BYTES + STREAM_TAG_BYTES);
  prefix.writeUInt32BE(buffered.seq, 0);
  prefix.writeUInt8(STREAM_CODES[buffered.stream] ?? 0, SEQ_PREFIX_BYTES);
  try {
    socket.send(Buffer.concat([prefix, buffered.bytes]));
  } catch {
    /* socket closed under our feet */
  }
}

function closeWith(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    /* socket already closed */
  }
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    /* socket closed under our feet */
  }
}

function parseLastSeq(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function clampDimension(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const floored = Math.floor(n);
  if (floored < 1) return null;
  return Math.min(floored, MAX_RESIZE_DIMENSION);
}

function isOriginAllowed(
  corsOrigins: string[] | "*",
  origin: string | undefined,
): boolean {
  if (corsOrigins === "*") return true;
  // Browsers ALWAYS send Origin on WebSocket upgrades — a missing Origin
  // means the request is from a non-browser (curl, internal script, an
  // attacker who stripped the header). When an explicit allowlist is
  // configured, an absent Origin is a rejection.
  if (!origin) return false;
  return corsOrigins.includes(origin);
}

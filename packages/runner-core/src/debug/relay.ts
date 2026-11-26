import { request, type IncomingMessage } from "node:http";

import type { DebugFrame } from "@telorun/debug-wire";

import { abortableDelay } from "../abortable-delay.js";
import type { InspectEndpoint } from "../backend.js";

export interface DebugRelayOptions {
  /** The workload's inspect endpoint: the stream is asked for over whatever
   *  connection `connect` opens. */
  inspect: InspectEndpoint;
  /** Delivered each parsed frame off the stream. */
  onFrame: (frame: DebugFrame) => void;
  /** Aborts the relay (session ended). */
  signal: AbortSignal;
  /** Each failed attempt. The workload's inspect server isn't up the instant the
   *  process starts; the relay retries until it answers or `signal` aborts. */
  onError?: (err: Error) => void;
}

const RECONNECT_DELAY_MS = 500;
const EVENTS_PATH = "/events";

/** The largest frame relayed as written. An event carrying a large invocation
 *  payload (a query's whole result set) runs to tens of megabytes; parsed and
 *  held in the session's replay buffer and every subscriber's queue, a few of
 *  them exhaust the runner's memory. A frame over this size is relayed as a
 *  stand-in naming the event and the size it had. */
export const DEBUG_FRAME_MAX_BYTES = 1024 * 1024;

/**
 * Subscribe to a workload's inspect SSE endpoint and deliver each frame to
 * `onFrame`. Retries the connection until the endpoint answers or `signal`
 * aborts, and reconnects if the stream drops while the session is still live.
 * The runner relays these frames onward; the workload's inspect port is never
 * exposed outside it.
 *
 * Backend-neutral: it speaks HTTP over the stream the backend's opener returns
 * (a supervisor port forward, a loopback socket).
 */
export async function relayDebugStream(opts: DebugRelayOptions): Promise<void> {
  const { inspect, onFrame, signal } = opts;
  // The last id delivered, carried across reconnects. Without it a drop replays
  // the producer's whole buffer, and a consumer that DERIVES state from the
  // stream — the run projection counting generations — re-counts every reload
  // still in that buffer. In a watch session that is one pair per save.
  let lastEventId = 0;
  while (!signal.aborted) {
    try {
      const res = await subscribe(inspect, lastEventId, signal);
      if (res.statusCode === 200) {
        await pump(res, onFrame, signal, (id) => {
          lastEventId = id;
        });
      } else {
        res.destroy();
        opts.onError?.(new Error(`the inspect endpoint answered ${res.statusCode}`));
      }
    } catch (err) {
      if (signal.aborted) return;
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
    await abortableDelay(RECONNECT_DELAY_MS, signal);
  }
}

/** `GET /events` over a connection the endpoint opens. */
async function subscribe(inspect: InspectEndpoint, lastEventId: number, signal: AbortSignal): Promise<IncomingMessage> {
  const connection = await inspect.connect(signal);
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = request({
      path: EVENTS_PATH,
      signal,
      headers: {
        host: inspect.listen,
        accept: "text/event-stream",
        ...(lastEventId > 0 ? { "last-event-id": String(lastEventId) } : {}),
      },
      createConnection: () => connection,
    });
    req.once("response", resolve);
    req.once("error", reject);
    req.end();
  });
}

async function pump(
  body: IncomingMessage,
  onFrame: (frame: DebugFrame) => void,
  signal: AbortSignal,
  onId: (id: number) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  // Where the search for the next separator resumes, so a frame arriving in
  // many chunks is scanned once rather than once per chunk.
  let scanned = 0;
  try {
    for await (const value of body as AsyncIterable<Buffer>) {
      if (signal.aborted) return;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE frames are separated by a blank line.
      while ((sep = buf.indexOf("\n\n", scanned)) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        scanned = 0;
        const frame = block.length > DEBUG_FRAME_MAX_BYTES ? oversizedFrame(block) : parseSseData(block);
        if (!frame) continue;
        onFrame(frame);
        // Checkpoint AFTER delivery, so a frame the consumer never saw is not
        // skipped on the next reconnect.
        const id = parseSseId(block);
        if (id !== null) onId(id);
      }
      scanned = Math.max(0, buf.length - 1);
    }
  } finally {
    body.destroy();
  }
}

/** The `id:` of one SSE frame, or null when the producer sent none — an older
 *  kernel, whose stream simply has no resume point. */
function parseSseId(block: string): number | null {
  for (const line of block.split("\n")) {
    if (!line.startsWith("id:")) continue;
    const parsed = Number.parseInt(line.slice(3).trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** The stand-in for a frame too large to relay: the event's name and timestamp,
 *  read off the frame's head without parsing the rest, and the size it had. */
function oversizedFrame(block: string): DebugFrame {
  const head = block.slice(0, 4096);
  const field = (name: string) => new RegExp(`"${name}":"([^"\\\\]*)"`).exec(head)?.[1];
  return {
    kind: "event",
    timestamp: field("timestamp") ?? new Date().toISOString(),
    event: field("event") ?? "Runner.DebugFrameOmitted",
    payload: {
      omitted: `this frame was ${block.length} bytes, over the ${DEBUG_FRAME_MAX_BYTES} a runner relays; read it from the workload's own debug output`,
      bytes: block.length,
    },
  };
}

/** Extract and parse the `data:` payload of one SSE frame. Ignores comment
 *  lines (`: heartbeat`) and unparseable frames. */
function parseSseData(block: string): DebugFrame | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data) as DebugFrame;
  } catch {
    return null;
  }
}

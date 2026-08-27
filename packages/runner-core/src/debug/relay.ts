import type { DebugFrame } from "@telorun/debug-wire";

import { abortableDelay } from "../abortable-delay.js";

export interface DebugRelayOptions {
  /** The workload's inspect SSE endpoint, e.g. `http://telo-run-<id>:9230/events`.
   *  Reachable only by the runner over the backend's private network. */
  url: string;
  /** Delivered each parsed frame off the stream. */
  onFrame: (frame: DebugFrame) => void;
  /** Aborts the relay (session ended). */
  signal: AbortSignal;
  /** Optional connect-retry budget. The workload's inspect server isn't up the
   *  instant the container starts; we retry until it answers or `signal` aborts.
   *  Default: retry indefinitely (until abort). */
  onError?: (err: Error) => void;
}

const RECONNECT_DELAY_MS = 500;

/**
 * Subscribe to a workload's inspect SSE endpoint and deliver each frame to
 * `onFrame`. Retries the connection until the endpoint answers or `signal`
 * aborts, and reconnects if the stream drops while the session is still live.
 * The runner relays these frames onward; the workload's inspect port is never
 * exposed outside the runner.
 *
 * Backend-neutral (uses global `fetch`); the docker and k8s backends share it.
 */
export async function relayDebugStream(opts: DebugRelayOptions): Promise<void> {
  const { url, onFrame, signal } = opts;
  // The last id delivered, carried across reconnects. Without it a drop replays
  // the producer's whole buffer, and a consumer that DERIVES state from the
  // stream — the run projection counting generations — re-counts every reload
  // still in that buffer. In a watch session that is one pair per save.
  let lastEventId = 0;
  while (!signal.aborted) {
    try {
      const res = await fetch(url, {
        signal,
        headers: {
          accept: "text/event-stream",
          ...(lastEventId > 0 ? { "last-event-id": String(lastEventId) } : {}),
        },
      });
      if (!res.ok || !res.body) {
        await abortableDelay(RECONNECT_DELAY_MS, signal);
        continue;
      }
      await pump(res.body, onFrame, signal, (id) => {
        lastEventId = id;
      });
    } catch (err) {
      if (signal.aborted) return;
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
    await abortableDelay(RECONNECT_DELAY_MS, signal);
  }
}

async function pump(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: DebugFrame) => void,
  signal: AbortSignal,
  onId: (id: number) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE frames are separated by a blank line.
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const frame = parseSseData(block);
        if (!frame) continue;
        onFrame(frame);
        // Checkpoint AFTER delivery, so a frame the consumer never saw is not
        // skipped on the next reconnect.
        const id = parseSseId(block);
        if (id !== null) onId(id);
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
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

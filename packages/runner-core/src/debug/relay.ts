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
  while (!signal.aborted) {
    try {
      const res = await fetch(url, {
        signal,
        headers: { accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) {
        await abortableDelay(RECONNECT_DELAY_MS, signal);
        continue;
      }
      await pump(res.body, onFrame, signal);
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
        const frame = parseSseData(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
        if (frame) onFrame(frame);
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
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

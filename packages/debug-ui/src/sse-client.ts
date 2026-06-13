import type { DebugEvent } from "./wire.js";

export interface DebugStreamHandlers {
  onEvent: (event: DebugEvent) => void;
  /** Connection state changes — drives a status indicator. */
  onStatus?: (status: "connecting" | "open" | "closed") => void;
}

/**
 * Connect to a producer's `/events` SSE endpoint. The browser's `EventSource`
 * handles reconnection on its own; on each (re)connect the producer re-flushes
 * its replay buffer, so a late or reconnected client always sees history.
 *
 * Returns a disposer that closes the connection. Runtime-agnostic: the URL can
 * point at a Node CLI run, a Docker-mapped port, or a future Rust kernel —
 * they all speak the same wire format.
 */
export function connectDebugStream(url: string, handlers: DebugStreamHandlers): () => void {
  handlers.onStatus?.("connecting");
  const source = new EventSource(url);

  source.onopen = () => handlers.onStatus?.("open");

  source.onmessage = (msg) => {
    if (!msg.data) return;
    try {
      handlers.onEvent(JSON.parse(msg.data) as DebugEvent);
    } catch {
      // A malformed frame shouldn't kill the stream; skip it.
    }
  };

  source.onerror = () => handlers.onStatus?.("connecting");

  return () => {
    source.close();
    handlers.onStatus?.("closed");
  };
}

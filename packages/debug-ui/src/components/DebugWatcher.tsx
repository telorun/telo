import { useEffect, useReducer, useRef, useState } from "react";
import type { AppEndpoint } from "../endpoints.js";
import { connectDebugStream } from "../sse-client.js";
import type { DebugTheme } from "../theme.js";
import type { DebugFrame } from "../wire.js";
import { DebugPanel } from "./DebugPanel.js";

export interface DebugWatcherProps {
  /** The producer's SSE endpoint, e.g. `http://localhost:9230/events`. */
  url: string;
  /** Ring-buffer cap; oldest frames drop past this. Default 5000. */
  maxEvents?: number;
  /** Color theme. Defaults to `"system"` (follows the OS). */
  theme?: DebugTheme;
}

/**
 * The standalone debug watcher: connects to `url`, retains a bounded ring buffer
 * of frames (events + logs), and renders the Logs / Events {@link DebugPanel}.
 * Pausing freezes the *view* while still collecting into the buffer, so nothing
 * is lost on resume.
 */
export function DebugWatcher({ url, maxEvents = 5000, theme }: DebugWatcherProps) {
  const bufferRef = useRef<DebugFrame[]>([]);
  const pausedRef = useRef(false);
  const [rev, bump] = useReducer((n: number) => n + 1, 0);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [paused, setPaused] = useState(false);
  const [endpoints, setEndpoints] = useState<AppEndpoint[]>([]);

  useEffect(() => {
    bufferRef.current = [];
    return connectDebugStream(url, {
      onStatus: setStatus,
      onFrame: (f) => {
        const buf = bufferRef.current;
        buf.push(f);
        if (buf.length > maxEvents) buf.splice(0, buf.length - maxEvents);
        if (!pausedRef.current) bump();
      },
    });
  }, [url, maxEvents]);

  // The producer advertises the running app's exposed addresses in its discovery
  // handshake. Endpoints whose host the producer couldn't know (loopback default)
  // arrive blank — fill them from the page origin so the link points where the
  // viewer actually reached the server (localhost locally, the bound host remotely).
  useEffect(() => {
    let cancelled = false;
    const origin = new URL(url).hostname;
    fetch(new URL("json/version", url).toString())
      .then((r) => (r.ok ? r.json() : null))
      .then((info: { appEndpoints?: AppEndpoint[] } | null) => {
        if (cancelled || !info?.appEndpoints) return;
        setEndpoints(info.appEndpoints.map((e) => ({ ...e, host: e.host || origin })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);

  function togglePause() {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next) bump();
  }

  function clear() {
    bufferRef.current = [];
    bump();
  }

  // Blob pointers are relative to the producer origin; resolve them against the
  // SSE URL so the standalone page and the editor (cross-origin) both work.
  const resolveBlobUrl = (rel: string) => new URL(rel, url).toString();

  return (
    <DebugPanel
      frames={bufferRef.current}
      revision={rev}
      status={status}
      paused={paused}
      onTogglePause={togglePause}
      onClear={clear}
      resolveBlobUrl={resolveBlobUrl}
      endpoints={endpoints}
      theme={theme}
    />
  );
}

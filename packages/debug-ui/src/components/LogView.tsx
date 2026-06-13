import { useEffect, useRef } from "react";
import { stripAnsi } from "../ansi.js";
import type { DebugLog } from "../wire.js";

export interface LogViewProps {
  logs: readonly DebugLog[];
}

/** Chronological stdout/stderr view (oldest first), autoscrolled to the tail.
 *  stderr lines are tinted. ANSI escapes are stripped for display. */
export function LogView({ logs }: LogViewProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [logs.length]);

  if (logs.length === 0) {
    return <div className="tdbg-empty">No output yet — waiting for the stream…</div>;
  }

  return (
    <div className="tdbg-logs" role="log" aria-live="polite">
      {logs.map((l, i) => (
        <div className={`tdbg-logline tdbg-log-${l.stream}`} key={i}>
          <span className="tdbg-time">{l.timestamp.slice(11, 23)}</span>
          <span className="tdbg-logtext">{stripAnsi(l.line)}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

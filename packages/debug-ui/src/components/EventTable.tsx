import { useState } from "react";
import { type DebugEvent, eventSuffix } from "../wire.js";
import { PayloadInspector } from "./PayloadInspector.js";

export interface EventTableProps {
  events: readonly DebugEvent[];
  resolveUrl: (rel: string) => string;
}

/** Newest-first list of events; each row expands to its payload. Expansion is
 *  keyed by event identity so it survives re-renders as new events stream in. */
export function EventTable({ events, resolveUrl }: EventTableProps) {
  const [open, setOpen] = useState<Set<DebugEvent>>(new Set());

  function toggle(e: DebugEvent) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(e)) next.delete(e);
      else next.add(e);
      return next;
    });
  }

  if (events.length === 0) {
    return <div className="tdbg-empty">No events match — waiting for the stream…</div>;
  }

  return (
    <div className="tdbg-table" role="log" aria-live="polite">
      {events
        .map((e, i) => ({ e, i }))
        .reverse()
        .map(({ e, i }) => {
          const suffix = eventSuffix(e.event);
          return (
            <div className="tdbg-row" key={i}>
              <button
                className="tdbg-rowhead"
                onClick={() => toggle(e)}
                aria-expanded={open.has(e)}
              >
                <span className="tdbg-caret">{open.has(e) ? "▾" : "▸"}</span>
                <span className="tdbg-time">{e.timestamp.slice(11, 23)}</span>
                <span className={`tdbg-badge tdbg-suffix-${suffix.toLowerCase()}`}>{suffix}</span>
                <span className="tdbg-name">{e.event}</span>
                <span className="tdbg-preview">{preview(e.payload)}</span>
              </button>
              {open.has(e) && <PayloadInspector value={e.payload} resolveUrl={resolveUrl} />}
            </div>
          );
        })}
    </div>
  );
}

function preview(payload: unknown): string {
  if (payload == null) return "";
  let text: string;
  try {
    text = typeof payload === "string" ? payload : JSON.stringify(payload);
  } catch {
    return "";
  }
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

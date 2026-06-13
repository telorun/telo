import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { distinctSuffixes, type EventFilter, matchesFilter } from "../filter.js";
import { connectDebugStream } from "../sse-client.js";
import type { DebugEvent } from "../wire.js";
import { EventTable } from "./EventTable.js";
import { FilterBar } from "./FilterBar.js";
import "./styles.css";

export interface DebugWatcherProps {
  /** The producer's SSE endpoint, e.g. `http://localhost:9230/events`. */
  url: string;
  /** Ring-buffer cap; oldest events drop past this. Default 5000. */
  maxEvents?: number;
}

/**
 * The full debug-watcher view: connects to `url`, retains a bounded ring buffer,
 * and renders a filterable, pausable, newest-first event stream. Pausing freezes
 * the *view* while still collecting into the buffer, so nothing is lost on resume.
 *
 * Self-contained and prop-driven — the standalone app and the editor panel both
 * mount this; only the `url` differs.
 */
export function DebugWatcher({ url, maxEvents = 5000 }: DebugWatcherProps) {
  const bufferRef = useRef<DebugEvent[]>([]);
  const pausedRef = useRef(false);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [filter, setFilter] = useState<EventFilter>({});
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    bufferRef.current = [];
    return connectDebugStream(url, {
      onStatus: setStatus,
      onEvent: (e) => {
        const buf = bufferRef.current;
        buf.push(e);
        if (buf.length > maxEvents) buf.splice(0, buf.length - maxEvents);
        if (!pausedRef.current) bump();
      },
    });
  }, [url, maxEvents]);

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
  const resolveUrl = (rel: string) => new URL(rel, url).toString();

  const all = bufferRef.current;
  // `all.length` + `paused` are the render signal (the ref array is mutated in
  // place); recompute the derived views against the current buffer snapshot.
  const suffixes = useMemo(() => distinctSuffixes(all), [all.length, paused]);
  const visible = useMemo(
    () => all.filter((e) => matchesFilter(e, filter)),
    [all.length, filter, paused],
  );

  return (
    <div className="tdbg-root">
      <FilterBar
        filter={filter}
        onChange={setFilter}
        suffixes={suffixes}
        status={status}
        paused={paused}
        onTogglePause={togglePause}
        onClear={clear}
        total={all.length}
        shown={visible.length}
      />
      <EventTable events={visible} resolveUrl={resolveUrl} />
    </div>
  );
}

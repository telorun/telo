import { type ReactNode, useMemo, useState } from "react";
import type { AppEndpoint, EndpointReachability } from "../endpoints.js";
import { distinctSuffixes, type EventFilter, matchesFilter } from "../filter.js";
import { type DebugTheme, loadStoredTheme, storeTheme, useResolvedTheme } from "../theme.js";
import { type DebugEvent, type DebugFrame, isLogFrame } from "../wire.js";
import { EndpointLinks } from "./EndpointLinks.js";
import { EventGraph } from "./EventGraph.js";
import { EventTable } from "./EventTable.js";
import { FilterBar } from "./FilterBar.js";
import { LogView } from "./LogView.js";
import { ThemeToggle } from "./ThemeToggle.js";
import "./styles.css";

export interface DebugPanelProps {
  /** The frame buffer (events + logs) in arrival order. */
  frames: readonly DebugFrame[];
  /** Re-render signal: bump when `frames` mutates in place. Unneeded when the
   *  parent passes a fresh array reference on every change. */
  revision?: number;
  status: "connecting" | "open" | "closed";
  paused: boolean;
  onTogglePause: () => void;
  onClear: () => void;
  /** Resolve a blob pointer (path relative to the producer origin) to a URL. */
  resolveBlobUrl: (rel: string) => string;
  /** When provided, the Logs tab renders this instead of the built-in read-only
   *  {@link LogView} — e.g. the editor injects its interactive terminal here so
   *  the panel is writable. Standalone hosts omit it and get the log line view. */
  logsSlot?: ReactNode;
  /** Which tab is shown first. Default `"graph"`; the editor opens on `"logs"`
   *  so its interactive terminal is front-and-centre. */
  defaultTab?: Tab;
  /** Exposed addresses of the running application, rendered as links in the
   *  header. The standalone {@link DebugWatcher} sources these from the producer's
   *  handshake; the editor passes its resolved run endpoints. */
  endpoints?: readonly AppEndpoint[];
  /** Per-port reachability for the endpoint badges (spinner / ok / error). The
   *  editor sources it from the runner's `reachability` events. */
  endpointReachability?: ReadonlyMap<number, EndpointReachability>;
  /** Color theme. Defaults to `"system"` (follows the OS); an embedding host
   *  (e.g. the editor) passes its own resolved `"light"` / `"dark"`. */
  theme?: DebugTheme;
}

type Tab = "events" | "graph" | "logs";

/**
 * The presentation half of the debug watcher: a Logs / Events tab split over one
 * frame stream, with event filtering. Fully controlled — the standalone
 * {@link DebugWatcher} drives it from an SSE buffer; the editor drives it from
 * frames relayed over the run session. Only the source and `resolveBlobUrl` differ.
 */
export function DebugPanel({
  frames,
  revision,
  status,
  paused,
  onTogglePause,
  onClear,
  resolveBlobUrl,
  logsSlot,
  defaultTab = "graph",
  endpoints,
  endpointReachability,
  theme,
}: DebugPanelProps) {
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [filter, setFilter] = useState<EventFilter>({});
  // Controlled when the host supplies a theme; otherwise the panel owns its mode
  // (shows the toggle, persists the choice across reloads). `"system"` resolves
  // against the OS, live.
  const controlled = theme !== undefined;
  const [ownTheme, setOwnTheme] = useState<DebugTheme>(loadStoredTheme);
  const changeOwnTheme = (next: DebugTheme): void => {
    setOwnTheme(next);
    storeTheme(next);
  };
  const resolvedTheme = useResolvedTheme(controlled ? theme : ownTheme);

  // `revision` is the in-place-mutation signal; `frames` covers the fresh-array
  // pattern. Either changing recomputes the split.
  const events = useMemo(
    () => frames.filter((f): f is DebugEvent => !isLogFrame(f)),
    [frames, revision],
  );
  const logs = useMemo(() => frames.filter(isLogFrame), [frames, revision]);
  const suffixes = useMemo(() => distinctSuffixes(events), [events]);
  const visible = useMemo(
    () => events.filter((e) => matchesFilter(e, filter)),
    [events, filter],
  );

  return (
    <div className="tdbg-root" data-theme={resolvedTheme}>
      <div className="tdbg-tabs">
        <span className={`tdbg-status tdbg-status-${status}`} title={`stream ${status}`} />
        <button
          className={`tdbg-tab${tab === "graph" ? " tdbg-tab-on" : ""}`}
          onClick={() => setTab("graph")}
        >
          Graph
        </button>
        <button
          className={`tdbg-tab${tab === "events" ? " tdbg-tab-on" : ""}`}
          onClick={() => setTab("events")}
        >
          Events <span className="tdbg-tabcount">{events.length}</span>
        </button>
        <button
          className={`tdbg-tab${tab === "logs" ? " tdbg-tab-on" : ""}`}
          onClick={() => setTab("logs")}
        >
          Logs{logsSlot ? null : <span className="tdbg-tabcount">{logs.length}</span>}
        </button>
        <span className="tdbg-tabs-spacer" />
        {endpoints && endpoints.length > 0 && (
          <EndpointLinks endpoints={endpoints} reachability={endpointReachability} />
        )}
        <button className="tdbg-btn" onClick={onTogglePause}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button className="tdbg-btn" onClick={onClear}>
          Clear
        </button>
        {!controlled && <ThemeToggle value={ownTheme} onChange={changeOwnTheme} />}
      </div>
      {tab === "events" ? (
        <>
          <FilterBar
            filter={filter}
            onChange={setFilter}
            suffixes={suffixes}
            total={events.length}
            shown={visible.length}
            paused={paused}
          />
          <EventTable events={visible} resolveUrl={resolveBlobUrl} />
        </>
      ) : tab === "graph" ? (
        <EventGraph events={events} resolveUrl={resolveBlobUrl} />
      ) : logsSlot ? (
        <div className="tdbg-slot">{logsSlot}</div>
      ) : (
        <LogView logs={logs} />
      )}
    </div>
  );
}

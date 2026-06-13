import type { EventFilter } from "../filter.js";

export interface FilterBarProps {
  filter: EventFilter;
  onChange: (filter: EventFilter) => void;
  suffixes: string[];
  status: "connecting" | "open" | "closed";
  paused: boolean;
  onTogglePause: () => void;
  onClear: () => void;
  total: number;
  shown: number;
}

export function FilterBar({
  filter,
  onChange,
  suffixes,
  status,
  paused,
  onTogglePause,
  onClear,
  total,
  shown,
}: FilterBarProps) {
  const active = new Set(filter.suffixes ?? []);

  function toggleSuffix(suffix: string) {
    const next = new Set(active);
    if (next.has(suffix)) next.delete(suffix);
    else next.add(suffix);
    onChange({ ...filter, suffixes: next.size ? [...next] : undefined });
  }

  return (
    <div className="tdbg-bar">
      <div className="tdbg-bar-row">
        <span className={`tdbg-status tdbg-status-${status}`} title={`stream ${status}`} />
        <input
          className="tdbg-search"
          placeholder="Search event name or payload…"
          value={filter.text ?? ""}
          onChange={(e) => onChange({ ...filter, text: e.target.value || undefined })}
        />
        <input
          className="tdbg-kind"
          placeholder="kind / resource…"
          value={filter.kind ?? ""}
          onChange={(e) => onChange({ ...filter, kind: e.target.value || undefined })}
        />
        <button className="tdbg-btn" onClick={onTogglePause}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button className="tdbg-btn" onClick={onClear}>
          Clear
        </button>
        <span className="tdbg-counts">
          {shown === total ? `${total}` : `${shown} / ${total}`} events
          {paused ? " · paused" : ""}
        </span>
      </div>
      {suffixes.length > 0 && (
        <div className="tdbg-facets">
          {suffixes.map((s) => (
            <button
              key={s}
              className={`tdbg-facet${active.has(s) ? " tdbg-facet-on" : ""}`}
              onClick={() => toggleSuffix(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import { type DebugEvent, eventSuffix } from "./wire.js";

/**
 * A debug-event filter. All fields are AND-combined; an empty filter matches
 * everything. Pure and framework-agnostic so the standalone app and the editor
 * panel filter identically.
 */
export interface EventFilter {
  /** Free-text, case-insensitive; matched against the event name and the
   *  JSON-stringified payload. */
  text?: string;
  /** Allowed event suffixes (`Invoked`, `Failed`, …). Empty/undefined = all. */
  suffixes?: string[];
  /** Substring matched against the event name's prefix (the kind/resource part). */
  kind?: string;
}

const EMPTY: readonly string[] = [];

/** True when `event` passes `filter`. */
export function matchesFilter(event: DebugEvent, filter: EventFilter): boolean {
  const suffixes = filter.suffixes ?? EMPTY;
  if (suffixes.length > 0 && !suffixes.includes(eventSuffix(event.event))) {
    return false;
  }
  if (filter.kind) {
    // Lifecycle events carry the kind in the dotted name; dispatch (trace) events
    // carry it in `payload.ref.kind` (the name dropped the kind prefix). Match either.
    const refKind = (event.payload as { ref?: { kind?: unknown } } | undefined)?.ref?.kind;
    const haystack = `${event.event} ${typeof refKind === "string" ? refKind : ""}`.toLowerCase();
    if (!haystack.includes(filter.kind.toLowerCase())) return false;
  }
  if (filter.text) {
    const needle = filter.text.toLowerCase();
    const haystack = `${event.event} ${safePayloadText(event.payload)}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** Distinct event suffixes present in `events`, sorted — drives the facet list. */
export function distinctSuffixes(events: readonly DebugEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) set.add(eventSuffix(e.event));
  return [...set].sort();
}

function safePayloadText(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return "";
  }
}

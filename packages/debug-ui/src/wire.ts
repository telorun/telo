/**
 * The Telo debug event wire format — the language-neutral contract between a
 * kernel runtime (the producer: Node today, Rust/Go later) and any consumer
 * (this UI, the editor). A producer serializes each emitted event to this shape;
 * consumers only ever parse it. The companion JSON Schema (`wire-schema.json`)
 * is the source of truth a non-TypeScript producer conforms to.
 */

/** One event as it travels over the wire (one JSON object per SSE message / JSONL line). */
export interface DebugEvent {
  /** ISO-8601 timestamp set by the producer when the event was emitted. */
  timestamp: string;
  /** Dotted event name, e.g. `Server.Listening`, `MyKind.MyName.Invoked`. */
  event: string;
  /** Arbitrary event payload, already reduced to wire-safe values (see encoding rules). */
  payload?: unknown;
  /** Optional producer-attached metadata (namespace, resource, kind, name, …). */
  metadata?: Record<string, unknown>;
}

/**
 * Value-encoding rules a producer applies before a value enters `payload`:
 *  - a resolved `!ref` (a live resource instance) → `{ kind, name }`
 *  - any other live / unrepresentable value (controller instance, stream, client,
 *    function, bigint) → a `"[Marker]"` string (e.g. `"[Stream]"`, `"[Kernel]"`)
 *  - a reference cycle → `"[Circular]"`
 *  - everything else → plain JSON
 * Consumers shouldn't assume `payload` is any particular shape.
 */

/** A resolved-reference value as it appears in a payload. */
export interface WireRef {
  kind: string;
  name: string;
}

/**
 * A binary value offloaded to the producer's blob store. The bytes are NOT in the
 * payload — `$blob` is a path (relative to the producer origin) the consumer
 * fetches on demand (e.g. `<img src>`, a download link). The object key this sits
 * under is preserved; only the bytes left the log.
 */
export interface WireBlob {
  $blob: string;
  mediaType: string;
  byteLength: number;
}

/** Narrow a payload value to a {@link WireBlob}. */
export function isWireBlob(value: unknown): value is WireBlob {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as WireBlob).$blob === "string" &&
    typeof (value as WireBlob).mediaType === "string"
  );
}

/** Narrow a payload value to a {@link WireRef} (e.g. to render it as a chip/link). */
export function isWireRef(value: unknown): value is WireRef {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as WireRef).kind === "string" &&
    typeof (value as WireRef).name === "string" &&
    Object.keys(value as object).length === 2
  );
}

/** The trailing segment of a dotted event name — the "kind" of event
 *  (`Invoked`, `Failed`, `Listening`, …). Used for facet filtering and color. */
export function eventSuffix(event: string): string {
  const dot = event.lastIndexOf(".");
  return dot >= 0 ? event.slice(dot + 1) : event;
}

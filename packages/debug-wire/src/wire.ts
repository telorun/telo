/**
 * The Telo debug wire format — the language-neutral contract between a kernel
 * runtime (the producer: Node today, Rust/Go later) and any consumer (the debug
 * UI, the editor). A producer serializes each emitted frame to this shape;
 * consumers only ever parse it. The companion JSON Schema (`wire-schema.json`)
 * is the source of truth a non-TypeScript producer conforms to.
 *
 * A stream carries two discriminated frame kinds on a single channel:
 *  - `kind: "event"` — a kernel event (lifecycle, resource invocation, …).
 *  - `kind: "log"`   — one line of the runtime's stdout/stderr.
 * Consumers route on `kind`; a frame with no `kind` is treated as an event
 * (tolerant of legacy event-only streams).
 */

/** A kernel event as it travels over the wire (one JSON object per SSE message / JSONL line). */
export interface DebugEvent {
  /** Discriminator. Optional for back-compat with legacy event-only streams. */
  kind?: "event";
  /** ISO-8601 timestamp set by the producer when the event was emitted. */
  timestamp: string;
  /** Dotted event name. Lifecycle events carry the kind (`MyKind.MyName.Created`);
   *  dispatch events drop it (`myName.Invoked`) and carry `{kind,name}` in the
   *  payload (see {@link TracePayload}). */
  event: string;
  /** Arbitrary event payload, already reduced to wire-safe values (see encoding rules). */
  payload?: unknown;
  /** Optional producer-attached metadata (namespace, resource, kind, name, …). */
  metadata?: Record<string, unknown>;
}

/** One line of the runtime's standard output/error, as it travels over the wire. */
export interface DebugLog {
  kind: "log";
  /** ISO-8601 timestamp set by the producer when the line was written. */
  timestamp: string;
  /** Which standard stream the line came from. */
  stream: "stdout" | "stderr";
  /** The line text (no trailing newline). ANSI escapes are preserved. */
  line: string;
}

/** One frame on the unified debug stream — either a kernel event or a log line. */
export type DebugFrame = DebugEvent | DebugLog;

/** Narrow a frame to a {@link DebugLog}. */
export function isLogFrame(frame: DebugFrame): frame is DebugLog {
  return (frame as DebugLog).kind === "log";
}

/** Narrow a frame to a {@link DebugEvent} (anything not explicitly a log). */
export function isEventFrame(frame: DebugFrame): frame is DebugEvent {
  return (frame as DebugLog).kind !== "log";
}

/**
 * Value-encoding rules a producer applies before a value enters an event `payload`:
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
 * The payload every capability *dispatch* event carries (invoke / run / provide).
 * The language-neutral trace contract: a consumer rebuilds the call tree purely
 * from these fields and never parses the dotted event name.
 *  - `spanId` / `parentSpanId` — present only while the producer is tracing;
 *    `parentSpanId` is absent at a trace root. The call tree is built from these.
 *  - `capability` — which capability method ran.
 *  - `phase` — `"start"` (in-flight, no `outcome`) or `"end"` (terminal).
 *  - `outcome` — terminal result; absent on a `start` event.
 *  - `ref` — the kind+name the event name no longer encodes.
 * Capability-specific detail (`inputs`, `outputs`, error `code`/`message`/`data`,
 * cancellation `reason`) rides alongside these as plain payload fields.
 */
export interface TracePayload {
  /** Groups all spans of one trace — minted at the root, inherited by descendants
   *  (OpenTelemetry `trace_id`). Present only while the producer is tracing. */
  traceId?: string;
  spanId?: number;
  parentSpanId?: number;
  /** Which capability ran. `"request"` is an inbound-boundary span (an HTTP
   *  request) — maps to an OTel SERVER span; the others are INTERNAL. */
  capability: "invoke" | "run" | "provide" | "request";
  phase: "start" | "end";
  outcome?: "ok" | "failed" | "rejected" | "cancelled";
  ref: WireRef;
  /** Human label for the span (e.g. a route `"POST /feedback"`). */
  label?: string;
  /** Structured span attributes (e.g. `{ method, path }`) — map to OTel attributes. */
  attributes?: Record<string, unknown>;
  /** On a trace's *root* span: a redacted snapshot of the CEL root scope available
   *  to the trace — `{ variables, secrets (masked), resources, ports }`. Lets a
   *  consumer see what data the execution could reference. Wire-encoded like any
   *  payload value; secret values are masked at the source. */
  context?: Record<string, unknown>;
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

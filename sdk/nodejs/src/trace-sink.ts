import type { SpanOutcome } from "./cancellation.js";
import type { AnyValue } from "./log-record.js";

/**
 * The trace-export contract — `kernel/specs/tracing.md`.
 *
 * On the module-author surface for the reason the log-sink contract is: a trace
 * sink is an ordinary module (`OTLP.TraceSink`), so what it implements cannot
 * sit behind a kernel-internal import.
 */

/**
 * One finished span, as the runtime hands it to every attached trace sink.
 *
 * Deliberately narrow: identity, timing, outcome and attributes. A span never
 * carries the dispatch's inputs, its outputs or the CEL scope it ran against —
 * those are payload, and a trace backend is not where payload is kept.
 */
export interface SpanRecord {
  /** 32 lowercase hex characters. */
  traceId: string;
  /** 16 lowercase hex characters. */
  spanId: string;
  /** Absent at a trace root. */
  parentSpanId?: string;
  name: string;
  /** Nanoseconds since the Unix epoch. */
  startTime: bigint;
  endTime: bigint;
  outcome: SpanOutcome;
  /** Declared and runtime attributes — `error.type` on a failed or rejected
   *  span, `telo.cancellation.reason` on a cancelled one. */
  attributes: Record<string, AnyValue>;
}

/** A `Telo.TraceSink` instance: where finished spans go. The runtime attaches the
 *  instances the root Application's `tracing.sinks` lists and writes to them
 *  directly, never through dispatch — dispatching would open a span per span. */
export interface TraceSinkInstance {
  /** Identity for diagnostics: the resource name. */
  readonly sinkId: string;
  /** Accept a finished span. MUST NOT throw — a sink failure is reported by the
   *  sink, never propagated into the dispatch that produced the span. */
  write(span: SpanRecord): void;
  /** Drain asynchronously. */
  flush(): Promise<void>;
  /** Drain before returning, where the destination allows it; a no-op for a
   *  network destination. */
  flushSync(): void;
  /** Release the destination. Called during teardown, after the final flush. */
  close(): Promise<void>;
}

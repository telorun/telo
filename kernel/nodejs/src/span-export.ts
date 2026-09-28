import { toPlainJson, type AnyValue, type SpanOutcome, type SpanRecord } from "@telorun/sdk";
import { formatSpanCounter } from "./logging/span-id.js";

/**
 * A finished span as a dispatch site knows it, turned into the record a trace
 * sink receives — `kernel/specs/tracing.md` §4.
 *
 * Ids stay counters until here, the encoding boundary, as the logging spec's
 * §7.1 requires of every emitted id.
 */
export interface FinishedSpan {
  name: string;
  traceId: string | undefined;
  spanId: number | undefined;
  /** A local span's counter, or an upstream span's id (a `traceparent`'s
   *  parent-id), which is emitted verbatim. */
  parentSpanId: number | string | undefined;
  startTime: bigint | undefined;
  endTime: bigint;
  outcome: SpanOutcome;
  /** Attribute values in the CEL value domain; `undefined` entries are left out. */
  attributes: Record<string, unknown>;
}

export function spanRecordOf(span: FinishedSpan): SpanRecord | undefined {
  // A span opened before tracing was switched on has no ids or start: it was
  // never a span, and exporting a half of one would invent a root.
  if (span.traceId === undefined || span.spanId === undefined || span.startTime === undefined) {
    return undefined;
  }
  const spanId = formatSpanCounter(span.spanId);
  if (spanId === undefined) return undefined;
  const parentSpanId =
    typeof span.parentSpanId === "string"
      ? span.parentSpanId
      : span.parentSpanId === undefined
        ? undefined
        : formatSpanCounter(span.parentSpanId);
  const attributes: Record<string, AnyValue> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (value === undefined) continue;
    attributes[key] = toPlainJson(value) as AnyValue;
  }
  return {
    traceId: span.traceId,
    spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    name: span.name,
    startTime: span.startTime,
    endTime: span.endTime,
    outcome: span.outcome,
    attributes,
  };
}

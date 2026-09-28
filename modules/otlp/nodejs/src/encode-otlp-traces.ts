import type { AnyValue, SpanOutcome, SpanRecord } from "@telorun/sdk";
import { toKeyValueList, withServiceName } from "./encode-otlp.js";

/**
 * Finished spans as one OTLP/JSON `ExportTraceServiceRequest` body, under the
 * same interop rules as the log encoding (`encode-otlp.ts`): 64-bit times as
 * decimal strings, trace and span ids as hex, enums as integers, attributes as a
 * `{ key, value }` list.
 */

/** `Span.SpanKind.SPAN_KIND_INTERNAL` — a span of work inside this process. */
const SPAN_KIND_INTERNAL = 1;

/** `Status.StatusCode`. */
const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/** OTLP's status has three values and Telo's outcome five, so the outcome also
 *  travels as the `telo.span.outcome` attribute. A cancelled or parked span
 *  neither succeeded nor failed, which is what `UNSET` says. */
const STATUS_OF: Record<SpanOutcome, number> = {
  ok: STATUS_OK,
  failed: STATUS_ERROR,
  rejected: STATUS_ERROR,
  cancelled: STATUS_UNSET,
  parked: STATUS_UNSET,
};

export function toOtlpTracePayload(
  spans: readonly SpanRecord[],
  options: { resourceAttributes?: Record<string, AnyValue> } = {},
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: toKeyValueList(withServiceName(options.resourceAttributes)) },
        scopeSpans: [{ scope: { name: "telo" }, spans: spans.map(toOtlpSpan) }],
      },
    ],
  };
}

function toOtlpSpan(span: SpanRecord): Record<string, unknown> {
  const errorType = span.attributes["error.type"];
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: span.startTime.toString(),
    endTimeUnixNano: span.endTime.toString(),
    attributes: toKeyValueList({ ...span.attributes, "telo.span.outcome": span.outcome }),
    status: {
      code: STATUS_OF[span.outcome],
      ...(STATUS_OF[span.outcome] === STATUS_ERROR && typeof errorType === "string"
        ? { message: errorType }
        : {}),
    },
  };
}

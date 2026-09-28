import {
  formatUnixNano,
  parseLevelName,
  SEVERITY,
  TEARDOWN_LAST,
  type LevelName,
  type LogAttributes,
  type ResourceInstance,
  type SpanRecord,
  type TraceSinkInstance,
} from "@telorun/sdk";
import type { BuiltinControllerContext } from "../../internal-context.js";
import { withRecordTraceIdentity } from "../../logging/span-record-identity.js";

/**
 * Controller for the `Telo.LogTraceSink` kernel built-in — `kernel/specs/tracing.md`
 * §5.2: each finished span becomes one structured record through the logging
 * pipeline, at the sink's `level`.
 *
 * The record IS the span: it carries the span's own trace and span ids, so a
 * log consumer sees it beside the records emitted inside that span, and it
 * reaches every log sink the application declared — console, file, OTLP.
 */

interface LogTraceSinkResource {
  metadata?: { name?: string };
  kind?: string;
  level?: string;
}

const NANOS_PER_MILLI = BigInt(1_000_000);

class LogTraceSink implements TraceSinkInstance {
  constructor(
    readonly sinkId: string,
    private readonly severity: number,
    private readonly ctx: BuiltinControllerContext,
  ) {}

  write(span: SpanRecord): void {
    const attributes: LogAttributes = {
      ...span.attributes,
      "telo.span.outcome": span.outcome,
      "telo.span.start_time": formatUnixNano(span.startTime),
      "telo.span.duration_ms": Number((span.endTime - span.startTime) / NANOS_PER_MILLI),
      ...(span.parentSpanId !== undefined ? { "telo.span.parent_span_id": span.parentSpanId } : {}),
    };
    withRecordTraceIdentity({ traceId: span.traceId, spanId: span.spanId }, () =>
      this.ctx.log.log(this.severity, span.name, attributes, { eventName: "telo.span" }),
    );
  }

  async flush(): Promise<void> {}

  flushSync(): void {}

  async close(): Promise<void> {}
}

export async function create(
  resource: LogTraceSinkResource,
  ctx: BuiltinControllerContext,
): Promise<ResourceInstance> {
  const sinkId = resource.metadata?.name ?? resource.kind ?? "Telo.LogTraceSink";
  const severity = parseLevelName((resource.level ?? "info") as LevelName) ?? SEVERITY.info;
  const sink = new LogTraceSink(sinkId, severity, ctx);
  // The instance IS the sink: the kernel attaches it when `tracing.sinks` lists
  // it, and unwinds it after every other resource.
  return Object.assign(sink, { teardownPriority: TEARDOWN_LAST }) as unknown as ResourceInstance;
}

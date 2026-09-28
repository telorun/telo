import { toOtlpTracePayload } from "./encode-otlp-traces.js";
import {
  bufferPolicyOf,
  DEFAULT_TIMEOUT_MS,
  postOtlp,
  type OtlpExportConfig,
} from "./otlp-exporter.js";
import {
  parseDurationMs,
  RecordBuffer,
  TEARDOWN_LAST,
  type AnyValue,
  type ControllerContext,
  type ResourceContext,
  type ResourceInstance,
  type SinkBufferPolicy,
  type SpanRecord,
  type TraceSinkInstance,
} from "@telorun/sdk";

/**
 * `OTLP.TraceSink` — export the runtime's finished spans to an OpenTelemetry
 * collector over OTLP/JSON (`kernel/specs/tracing.md` §5.3).
 *
 * The same buffering and delivery as the log sink: spans are held in a bounded
 * buffer and POSTed in batches on an interval, at teardown, and on `flush()`.
 * Delivery is a network round-trip, so nothing here is synchronously flushable.
 */
export function register(_ctx: ControllerContext): void {}

type OtlpTraceSinkConfig = OtlpExportConfig;

class OtlpTraceSink implements TraceSinkInstance {
  readonly #buffer: RecordBuffer<SpanRecord>;
  readonly #timeoutMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(
    readonly sinkId: string,
    private readonly config: OtlpTraceSinkConfig,
    policy: SinkBufferPolicy,
    private readonly ctx: ResourceContext,
  ) {
    this.#timeoutMs = config.timeout
      ? parseDurationMs(config.timeout, DEFAULT_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
    this.#buffer = new RecordBuffer<SpanRecord>(policy, () =>
      ctx.logging.recordDrop(sinkId, "buffer_full"),
    );
    this.#timer = setInterval(() => void this.flush(), policy.flushIntervalMs);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  write(span: SpanRecord): void {
    if (this.#closed) return;
    this.#buffer.push(span);
  }

  async flush(): Promise<void> {
    const spans = this.#buffer.drain();
    if (spans.length === 0) return;
    const payload = toOtlpTracePayload(spans, {
      resourceAttributes: this.config.resourceAttributes as Record<string, AnyValue> | undefined,
    });
    const failure = await postOtlp(
      this.config.endpoint,
      this.config.headers ?? {},
      this.#timeoutMs,
      payload,
    );
    if (failure !== undefined) {
      // The whole batch is lost, so the whole batch is counted.
      this.ctx.logging.recordDrop(this.sinkId, "sink_error", spans.length);
      this.ctx.log.warn(`Trace export to ${this.config.endpoint} failed: ${failure}`, {
        "telo.sink.id": this.sinkId,
        "telo.sink.dropped": spans.length,
      });
    }
  }

  flushSync(): void {
    // A network round-trip cannot complete synchronously.
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.flush();
    this.#closed = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}

export async function create(
  resource: OtlpTraceSinkConfig & { metadata?: { name?: string }; kind?: string },
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  const sinkId = resource.metadata?.name ?? resource.kind ?? "OTLP.TraceSink";
  const sink = new OtlpTraceSink(sinkId, resource, bufferPolicyOf(resource, sinkId), ctx);
  // The instance IS the sink: the kernel attaches it when `tracing.sinks` lists
  // it, and its undo exports what is still buffered before closing.
  return Object.assign(sink, { teardownPriority: TEARDOWN_LAST }) as unknown as ResourceInstance;
}

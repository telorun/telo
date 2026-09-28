import { toOtlpPayload } from "./encode-otlp.js";
import {
  bufferPolicyOf,
  DEFAULT_TIMEOUT_MS,
  postOtlp,
  type OtlpExportConfig,
} from "./otlp-exporter.js";
import {
  parseDurationMs,
  parseLevelName,
  RecordBuffer,
  SEVERITY,
  TEARDOWN_LAST,
  type ControllerContext,
  type LogRecord,
  type LogSinkInstance,
  type ResourceContext,
  type ResourceInstance,
  type SinkBufferPolicy,
} from "@telorun/sdk";

/**
 * `Otlp.Sink` — export structured log records to an OpenTelemetry collector.
 *
 * Shipped as a module rather than a kernel built-in for the mirror image of the
 * reason console and file are built in: §10.2 makes OTLP **optional**, and it
 * needs an HTTP endpoint, credentials, and a retry policy — all things the
 * resource graph already models. Conformance never depends on it being
 * installed.
 *
 * The encoding is fixed at `otlp` and cannot be overridden (§12.1): an OTLP
 * collector accepts exactly one wire format, so offering a choice would only
 * produce payloads it rejects.
 *
 * **Not sync-flushable.** Delivery is a network round-trip, which cannot
 * complete without yielding, so a `fatal` record's flush here is *initiated* and
 * not awaited. Records held only by this sink may be lost if the process dies
 * immediately after — an operator choosing OTLP for audit records is choosing
 * that exposure, and §10.5 requires it be documented rather than papered over.
 */
export function register(_ctx: ControllerContext): void {}

interface OtlpSinkConfig extends OtlpExportConfig {
  level?: string;
}

class OtlpSink implements LogSinkInstance {
  readonly sinkId: string;
  readonly level: number;
  readonly syncFlushable = false;

  readonly #buffer: RecordBuffer<LogRecord>;
  readonly #endpoint: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #resourceAttributes: Record<string, unknown>;
  readonly #ctx: ResourceContext;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(sinkId: string, config: OtlpSinkConfig, policy: SinkBufferPolicy, ctx: ResourceContext) {
    this.sinkId = sinkId;
    this.level = config.level ? (parseLevelName(config.level) ?? SEVERITY.info) : SEVERITY.info;
    this.#endpoint = config.endpoint;
    this.#headers = config.headers ?? {};
    this.#timeoutMs = config.timeout
      ? parseDurationMs(config.timeout, DEFAULT_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
    this.#resourceAttributes = config.resourceAttributes ?? {};
    this.#ctx = ctx;
    this.#buffer = new RecordBuffer(policy, () => ctx.logging.recordDrop(sinkId, "buffer_full"));

    this.#timer = setInterval(() => void this.flush(), policy.flushIntervalMs);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  write(record: LogRecord): void {
    if (this.#closed) return;
    this.#buffer.push(record);
  }

  async flush(): Promise<void> {
    const records = this.#buffer.drain();
    if (records.length === 0) return;

    const payload = toOtlpPayload(records, { resourceAttributes: this.#resourceAttributes as never });
    const failure = await postOtlp(this.#endpoint, this.#headers, this.#timeoutMs, payload);
    // A failed export loses the whole batch, so count every record, not one per
    // batch — a shutdown report that says "1" when a buffer of 8192 was lost is
    // the silent-loss §10.4 forbids. The reason is surfaced too, so an operator
    // can tell *why* exports fail rather than only that they do.
    if (failure !== undefined) this.#drop(records.length, failure);
  }

  #drop(count: number, reason: string): void {
    // Count the whole lost batch, not one-per-failure.
    this.#ctx.logging.recordDrop(this.sinkId, "sink_error", count);
    // The reason never reaches a sink (that would recurse through logging); it
    // goes to the process's real stderr, the §8.4 fallback diagnostic stream.
    process.stderr.write(`[telo:otlp] export to ${this.#endpoint} failed: ${reason}\n`);
  }

  flushSync(): void {
    // A network round-trip cannot complete synchronously. Blocking here on a
    // single-threaded event loop would be a deadlock, not durability, so the
    // fatal path initiates `flush()` without waiting instead.
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
  resource: OtlpSinkConfig & { metadata?: { name?: string }; kind?: string },
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  const sinkId = resource.metadata?.name ?? resource.kind ?? "Otlp.Sink";
  const policy = bufferPolicyOf(resource, sinkId);

  const sink = new OtlpSink(sinkId, resource, policy, ctx);

  // The instance IS the sink: the kernel attaches it when `logging.sinks` lists
  // it, and its undo flushes what is still buffered before closing.
  return Object.assign(sink, { teardownPriority: TEARDOWN_LAST }) as unknown as ResourceInstance;
}

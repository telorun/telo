import {
  DEFAULT_BUFFER_POLICY,
  RecordBuffer,
  type LogSinkInstance,
  type SinkBufferPolicy,
} from "@telorun/kernel";
import { toOtlpPayload } from "./encode-otlp.js";
import {
  parseDurationMs,
  parseLevelName,
  RuntimeError,
  SEVERITY,
  TEARDOWN_LAST,
  type ControllerContext,
  type LogRecord,
  type ResourceContext,
  type ResourceInstance,
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

interface OtlpSinkConfig {
  endpoint: string;
  headers?: Record<string, string>;
  level?: string;
  buffer?: number;
  on_full?: string;
  flush_interval?: string;
  timeout?: string;
  resourceAttributes?: Record<string, unknown>;
}

class OtlpSink implements LogSinkInstance {
  readonly sinkId: string;
  readonly level: number;
  readonly syncFlushable = false;

  readonly #buffer: RecordBuffer;
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
    this.#timeoutMs = config.timeout ? parseDurationMs(config.timeout, 10_000) : 10_000;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.#headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        // A failed export loses the whole batch, so count every record, not one
        // per batch — a shutdown report that says "1" when a buffer of 8192 was
        // lost is the silent-loss §10.4 forbids. The reason is surfaced too, so
        // an operator can tell *why* exports fail rather than only that they do.
        this.#drop(records.length, `HTTP ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      this.#drop(records.length, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      clearTimeout(timer);
    }
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

  if (resource.on_full === "block") {
    throw new RuntimeError(
      "ERR_LOG_SINK_ON_FULL_UNSUPPORTED",
      `Sink "${sinkId}": on_full: block is not supported by this runtime ` +
        `(single-threaded event loop — blocking the producer would stall the writer). ` +
        `Use \`drop_new\` or \`drop_old\`, or move this sink to a worker thread.`,
    );
  }

  const policy: SinkBufferPolicy = {
    buffer: resource.buffer ?? DEFAULT_BUFFER_POLICY.buffer,
    onFull: (resource.on_full ?? DEFAULT_BUFFER_POLICY.onFull) as SinkBufferPolicy["onFull"],
    flushIntervalMs: resource.flush_interval
      ? parseDurationMs(resource.flush_interval, DEFAULT_BUFFER_POLICY.flushIntervalMs)
      : DEFAULT_BUFFER_POLICY.flushIntervalMs,
  };

  const sink = new OtlpSink(sinkId, resource, policy, ctx);
  ctx.logging.attach(sink);

  return {
    sink,
    teardownPriority: TEARDOWN_LAST,
    teardown: async () => {
      await sink.flush();
      ctx.logging.detach(sink);
      await sink.close();
    },
  } as unknown as ResourceInstance;
}

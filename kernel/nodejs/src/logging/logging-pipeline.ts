import {
  nowUnixNano,
  severityText as canonicalSeverityText,
  SEVERITY,
  type LogAttributes,
  type LogAttributesInput,
  type LogOptions,
  type Logger,
  type LogRecord,
  type ResourceRef,
} from "@telorun/sdk";
import { DropRegistry, PIPELINE_SINK_ID, type DropReport } from "./drop-accounting.js";
import type { DropCause, LogSinkInstance } from "./log-sink.js";
import { normalizeAttributes, type AttributeLimits } from "./normalize-attributes.js";
import { EMPTY_REDACTION_POLICY, redactAttributes, redactError, type RedactionPolicy } from "./redact-attributes.js";
import { Sampler, type SamplingConfig } from "./sampler.js";
import type { ScopeConfig } from "./scope-config.js";

export type { ScopeConfig } from "./scope-config.js";
import { toErrorValue } from "./to-error-value.js";

/**
 * The emission pipeline — `kernel/specs/logging.md` §10.1:
 *
 *     controller → Logger → [threshold] → [redaction] → [sampling] → fan-out → Sink₁..Sinkₙ
 *
 * Redaction runs **before** serialization and before any sink sees the record.
 *
 * The logger core is deliberately independent of the sink set (D1): the debug
 * wire is *one sink*, not the pipeline. Logging works with no debug consumer
 * attached and with tracing off, and no sink depends on the event bus — which
 * short-circuits to zero cost when unsubscribed and therefore cannot carry logs.
 */

/** Ambient span context, supplied by the host so §7.2's automatic attachment
 *  needs no cooperation from the controller. Returns `undefined` when no span is
 *  active, in which case all three trace fields are omitted. */
export type TraceContextProvider = () =>
  | { traceId: string; spanId: string; traceFlags?: number }
  | undefined;

export const ROOT_SCOPE_CONFIG: ScopeConfig = {
  threshold: SEVERITY.info,
  redaction: EMPTY_REDACTION_POLICY,
};

export interface PipelineOptions {
  /** The process's real stderr — the fallback diagnostic stream of §8.4. This is
   *  the one place a logger may not surface an error inline; it is reported
   *  out-of-band, never swallowed. */
  fallbackStream: { write(chunk: string): unknown };
  traceContext?: TraceContextProvider;
  limits?: AttributeLimits;
  /** Records held before the first declared sink attaches, replayed in order
   *  (§12.1). Bounded, and overflow is counted like any other drop. */
  bootstrapCapacity?: number;
}

const DEFAULT_BOOTSTRAP_CAPACITY = 1024;
const FALLBACK_REPORT_INTERVAL_MS = 5000;

export class LoggingPipeline {
  readonly #sinks: LogSinkInstance[] = [];
  readonly #drops: DropRegistry;
  readonly #fallback: { write(chunk: string): unknown };
  readonly #limits: AttributeLimits | undefined;
  readonly #bootstrapCapacity: number;
  #traceContext: TraceContextProvider | undefined;

  /** Bumped whenever the sink set changes, so a logger's cached gate
   *  invalidates without every logger being tracked and rewritten (§12.4). */
  #gateVersion = 0;
  #gateCache = new Map<number, number>();

  #bootstrap: LogRecord[] | undefined = [];
  #bootstrapDropped = 0;
  readonly #samplers = new Map<ScopeConfig, Sampler>();
  readonly #lastFallbackReport = new Map<string, number>();

  constructor(options: PipelineOptions) {
    this.#fallback = options.fallbackStream;
    this.#traceContext = options.traceContext;
    this.#limits = options.limits;
    this.#bootstrapCapacity = options.bootstrapCapacity ?? DEFAULT_BOOTSTRAP_CAPACITY;
    this.#drops = new DropRegistry((report) => this.#reportDrops(report));
  }

  /** Wire the ambient trace source once the kernel's tracer exists. */
  setTraceContextProvider(provider: TraceContextProvider | undefined): void {
    this.#traceContext = provider;
  }

  get sinkCount(): number {
    return this.#sinks.length;
  }

  /**
   * Attach a sink and replay the bootstrap backlog into it, in original order.
   * Attaching changes the minimum-level gate, so it is recomputed and the new
   * threshold propagates to guests (§12.4).
   */
  attach(sink: LogSinkInstance): void {
    this.#sinks.push(sink);
    this.#invalidateGate();
    if (this.#bootstrap) {
      for (const record of this.#bootstrap) {
        if (record.severityNumber >= sink.level) this.#writeTo(sink, record);
      }
    }
  }

  detach(sink: LogSinkInstance): void {
    const index = this.#sinks.indexOf(sink);
    if (index >= 0) this.#sinks.splice(index, 1);
    this.#invalidateGate();
  }

  /**
   * Stop holding records for replay. Called once every declared sink has
   * attached: the bootstrap buffer covers the pre-attach window, and a consumer
   * connecting later (the debug wire) wants the live stream, not the whole
   * process history.
   */
  sealBootstrap(): void {
    if (this.#bootstrapDropped > 0) {
      this.#drops.record(PIPELINE_SINK_ID, "buffer_full", this.#bootstrapDropped);
      this.#bootstrapDropped = 0;
    }
    this.#bootstrap = undefined;
  }

  /**
   * The severity at or above which a record is created for a scope at
   * `scopeThreshold`: the minimum — most verbose — effective level across all
   * attached sinks. A record failing this gate reaches no sink and is never
   * created, formatted, or sent across an FFI boundary.
   *
   * With no sink attached the scope's own threshold governs, so records still
   * reach the bootstrap buffer and are replayed once a sink arrives.
   */
  gateFor(scopeThreshold: number): number {
    const cached = this.#gateCache.get(scopeThreshold);
    if (cached !== undefined) return cached;
    let gate = scopeThreshold;
    if (this.#sinks.length > 0) {
      gate = Number.POSITIVE_INFINITY;
      for (const sink of this.#sinks) {
        const effective = Number.isFinite(sink.level) ? sink.level : scopeThreshold;
        if (effective < gate) gate = effective;
      }
    }
    this.#gateCache.set(scopeThreshold, gate);
    return gate;
  }

  get gateVersion(): number {
    return this.#gateVersion;
  }

  /** Count a drop against a sink. Exposed so a sink's own buffer can report
   *  saturation without reaching into the registry directly. */
  recordDrop(sinkId: string, cause: DropCause, count = 1): void {
    this.#drops.record(sinkId, cause, count);
  }

  /** Lifetime drop total for a (sink, cause) pair, for assertions and for the
   *  shutdown report. */
  dropTotal(sinkId: string, cause: DropCause): number {
    return this.#drops.total(sinkId, cause);
  }

  createLogger(scope: ScopeConfig, resource?: ResourceRef, bound?: LogAttributes): Logger {
    return new ScopedLogger(this, scope, resource, bound);
  }

  /** Build and dispatch a record. Never throws (§8.4). */
  emit(
    scope: ScopeConfig,
    severity: number,
    message: string,
    resource: ResourceRef | undefined,
    bound: LogAttributes | undefined,
    attributes: LogAttributesInput | undefined,
    options: LogOptions | undefined,
  ): void {
    try {
      const record = this.#buildRecord(scope, severity, message, resource, bound, attributes, options);

      const sampler = this.#samplerFor(scope);
      if (sampler && !sampler.shouldEmit(record, Date.now())) {
        this.#drops.record(PIPELINE_SINK_ID, "sampled");
        return;
      }

      this.#dispatch(record);

      // `fatal` never alters control flow — no exit, no panic — but it does
      // oblige an immediate flush: synchronous on every sink that supports it,
      // initiated without waiting on the rest (§10.5).
      if (severity >= SEVERITY.fatal) this.flushFatal();
    } catch (err) {
      this.#reportFallback("<pipeline>", err);
    }
  }

  #buildRecord(
    scope: ScopeConfig,
    severity: number,
    message: string,
    resource: ResourceRef | undefined,
    bound: LogAttributes | undefined,
    attributes: LogAttributesInput | undefined,
    options: LogOptions | undefined,
  ): LogRecord {
    const merged: LogAttributesInput | undefined =
      bound || attributes || scope.attributes
        ? { ...scope.attributes, ...bound, ...attributes }
        : undefined;

    const normalized = normalizeAttributes(merged, {
      limits: this.#limits,
      secretValues: scope.secretValues,
      censor: scope.redaction.censor,
    });

    redactAttributes(normalized.attributes, scope.redaction);

    const error = options?.error === undefined ? undefined : toErrorValue(options.error);
    redactError(error, scope.redaction);

    const timestamp = options?.timestamp ?? nowUnixNano();
    const record: LogRecord = {
      timestamp,
      severityNumber: severity,
      severityText: options?.severityText ?? canonicalSeverityText(severity),
      message,
    };

    // A bridged record's origin time precedes the moment the runtime saw it.
    if (options?.timestamp !== undefined) record.observedTimestamp = nowUnixNano();
    if (normalized.attributes && Object.keys(normalized.attributes).length > 0) {
      record.attributes = normalized.attributes;
    }
    if (normalized.droppedCount > 0) record.droppedAttributesCount = normalized.droppedCount;
    if (error) record.error = error;
    if (resource) record.resource = resource;
    if (scope.module) record.module = scope.module;
    if (scope.scope) record.scope = scope.scope;
    if (options?.eventName) record.eventName = options.eventName.slice(0, 256);

    const trace = this.#traceContext?.();
    if (trace) {
      record.traceId = trace.traceId;
      record.spanId = trace.spanId;
      if (trace.traceFlags !== undefined) record.traceFlags = trace.traceFlags;
    }

    return record;
  }

  #dispatch(record: LogRecord): void {
    if (this.#sinks.length === 0) {
      this.#bufferBootstrap(record);
      return;
    }
    if (this.#bootstrap) this.#bufferBootstrap(record);
    for (const sink of this.#sinks) {
      if (record.severityNumber < sink.level) continue;
      this.#writeTo(sink, record);
    }
  }

  #writeTo(sink: LogSinkInstance, record: LogRecord): void {
    try {
      sink.write(record);
    } catch (err) {
      this.#drops.record(sink.sinkId, "sink_error");
      this.#reportFallback(sink.sinkId, err);
    }
  }

  #bufferBootstrap(record: LogRecord): void {
    const buffer = this.#bootstrap;
    if (!buffer) return;
    if (buffer.length >= this.#bootstrapCapacity) {
      this.#bootstrapDropped += 1;
      return;
    }
    buffer.push(record);
  }

  #samplerFor(scope: ScopeConfig): Sampler | undefined {
    if (!scope.sampling) return undefined;
    let sampler = this.#samplers.get(scope);
    if (!sampler) {
      sampler = new Sampler(scope.sampling);
      this.#samplers.set(scope, sampler);
    }
    return sampler;
  }

  #invalidateGate(): void {
    this.#gateVersion += 1;
    this.#gateCache = new Map();
  }

  /** §10.5's fatal tiering: drain every sync-flushable sink to completion before
   *  returning, and merely *initiate* the rest. Blocking on a sink that cannot
   *  be synchronously drained is a deadlock on an event loop, not durability. */
  flushFatal(): void {
    for (const sink of this.#sinks) {
      try {
        if (sink.syncFlushable) sink.flushSync();
        else void sink.flush().catch((err) => this.#reportFallback(sink.sinkId, err));
      } catch (err) {
        this.#reportFallback(sink.sinkId, err);
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.all(
      this.#sinks.map((sink) =>
        sink.flush().catch((err) => {
          this.#drops.record(sink.sinkId, "sink_error");
          this.#reportFallback(sink.sinkId, err);
        }),
      ),
    );
  }

  /** Final flush and release. Outstanding drop reports are emitted first so a
   *  run that ends while still dropping does not lose its accounting. */
  async close(): Promise<void> {
    this.#drops.reportPending();
    await this.flush();
    await Promise.all(
      this.#sinks.map((sink) =>
        sink.close().catch((err) => this.#reportFallback(sink.sinkId, err)),
      ),
    );
    this.#sinks.length = 0;
    this.#drops.dispose();
    this.#invalidateGate();
  }

  /** The recovery warning §10.4 requires once drops cease. Emitted as an
   *  ordinary record so it reaches every sink. */
  #reportDrops(report: DropReport): void {
    this.emit(
      ROOT_SCOPE_CONFIG,
      SEVERITY.warn,
      `dropped ${report.count} log record(s)`,
      undefined,
      undefined,
      {
        "telo.log.sink": report.sinkId,
        "telo.log.drop_cause": report.cause,
        "telo.log.dropped": report.count,
        "telo.log.dropped_total": report.total,
      },
      { eventName: "telo.log.dropped" },
    );
  }

  /**
   * §8.4: a sink failure never propagates to the caller and is never silently
   * discarded — it goes to the process's real stderr, at most once per sink per
   * interval, and is counted.
   */
  #reportFallback(sinkId: string, err: unknown): void {
    const now = Date.now();
    const last = this.#lastFallbackReport.get(sinkId) ?? 0;
    if (now - last < FALLBACK_REPORT_INTERVAL_MS) return;
    this.#lastFallbackReport.set(sinkId, now);
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    try {
      this.#fallback.write(`[telo:logging] sink "${sinkId}" failed: ${detail}\n`);
    } catch {
      // The fallback stream itself is gone. There is nowhere left to report to,
      // and throwing here would break the application — which §8.4 forbids.
    }
  }
}

class ScopedLogger implements Logger {
  readonly #pipeline: LoggingPipeline;
  readonly #scope: ScopeConfig;
  readonly #resource: ResourceRef | undefined;
  readonly #bound: LogAttributes | undefined;
  #cachedGate = Number.NaN;
  #cachedVersion = -1;

  constructor(
    pipeline: LoggingPipeline,
    scope: ScopeConfig,
    resource: ResourceRef | undefined,
    bound: LogAttributes | undefined,
  ) {
    this.#pipeline = pipeline;
    this.#scope = scope;
    this.#resource = resource;
    this.#bound = bound;
  }

  enabled(severity: number): boolean {
    const version = this.#pipeline.gateVersion;
    if (version !== this.#cachedVersion) {
      this.#cachedGate = this.#pipeline.gateFor(this.#scope.threshold);
      this.#cachedVersion = version;
    }
    return severity >= this.#cachedGate;
  }

  log(
    severity: number,
    message: string,
    attributes?: LogAttributesInput,
    options?: LogOptions,
  ): void {
    if (!this.enabled(severity)) return;
    this.#pipeline.emit(
      this.#scope,
      severity,
      message,
      this.#resource,
      this.#bound,
      attributes,
      options,
    );
  }

  /** Binding merges once, here — never per record — so a child logger costs one
   *  spread at creation and nothing at emit time (§8.3). */
  with(attributes: LogAttributesInput): Logger {
    const normalized = normalizeAttributes(attributes).attributes;
    return new ScopedLogger(this.#pipeline, this.#scope, this.#resource, {
      ...this.#bound,
      ...normalized,
    });
  }

  flush(): Promise<void> {
    return this.#pipeline.flush();
  }

  trace(message: string, attributes?: LogAttributesInput, options?: LogOptions): void {
    this.log(SEVERITY.trace, message, attributes, options);
  }
  debug(message: string, attributes?: LogAttributesInput, options?: LogOptions): void {
    this.log(SEVERITY.debug, message, attributes, options);
  }
  info(message: string, attributes?: LogAttributesInput, options?: LogOptions): void {
    this.log(SEVERITY.info, message, attributes, options);
  }
  warn(message: string, attributes?: LogAttributesInput, options?: LogOptions): void {
    this.log(SEVERITY.warn, message, attributes, options);
  }
  error(message: string, attributes?: LogAttributesInput, options?: LogOptions): void {
    this.log(SEVERITY.error, message, attributes, options);
  }
  fatal(message: string, attributes?: LogAttributesInput, options?: LogOptions): void {
    this.log(SEVERITY.fatal, message, attributes, options);
  }
}

import { randomBytes } from "node:crypto";
import type { SpanRecord, TraceCarrier, TraceSinkInstance, Tracer } from "@telorun/sdk";
import { formatSpanCounter } from "./logging/span-id.js";
import { formatTraceParent, TRACE_FLAG_RANDOM, TRACE_FLAG_SAMPLED } from "./logging/trace-parent.js";

/**
 * The kernel's invocation tracer: a monotonic counter, the attached trace sinks,
 * and the `enabled` gate. One instance per kernel, shared by reference across
 * the whole context tree, so invocation ids are unique within the run and
 * `enabled` toggles everywhere at once.
 *
 * Tracing is on while a debug consumer holds it on (`Kernel.setTracing`) or at
 * least one trace sink is attached — by the kernel, for the instances
 * `tracing.sinks` lists (`kernel/specs/tracing.md` §1). Off, `invoke`
 * skips id minting and the extra ALS scope entirely — tracing costs nothing until
 * someone is watching.
 */
export class KernelTracer implements Tracer {
  #debug = false;
  #next = 0;
  readonly #sinks = new Set<TraceSinkInstance>();
  /** Where a sink that throws from `write` is reported. The kernel wires its own
   *  logger here; a throw never reaches the dispatch that produced the span. */
  onSinkError: (sinkId: string, error: unknown) => void = () => {};

  get enabled(): boolean {
    return this.#debug || this.#sinks.size > 0;
  }

  /** True when a finished span has somewhere to go. */
  get exporting(): boolean {
    return this.#sinks.size > 0;
  }

  setDebug(enabled: boolean): void {
    this.#debug = enabled;
  }

  attach(sink: TraceSinkInstance): void {
    this.#sinks.add(sink);
  }

  detach(sink: TraceSinkInstance): void {
    this.#sinks.delete(sink);
  }

  /** Hand a finished span to every attached sink. */
  finish(span: SpanRecord): void {
    for (const sink of this.#sinks) {
      try {
        sink.write(span);
      } catch (err) {
        this.onSinkError(sink.sinkId, err);
      }
    }
  }

  next(): number {
    this.#next += 1;
    return this.#next;
  }

  /** What an upstream trace arrived with, per trace id, while a span continuing it
   *  is open: its flags and its `tracestate`, which a carrier hands on unchanged. */
  readonly #upstream = new Map<string, { flags: number; state?: string; open: number }>();

  /** Record that a span continues the upstream trace `traceId`; the returned
   *  release forgets it once the last such span settles. */
  continueUpstream(traceId: string, flags: number, state: string | undefined): () => void {
    const held = this.#upstream.get(traceId);
    if (held) held.open += 1;
    else this.#upstream.set(traceId, { flags, ...(state === undefined ? {} : { state }), open: 1 });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const entry = this.#upstream.get(traceId);
      if (entry && --entry.open === 0) this.#upstream.delete(traceId);
    };
  }

  /**
   * The span `spanCounter` of trace `traceId` as a W3C carrier: its id salted and
   * rendered as every exported record renders it, so a span continuing the carrier
   * names it as its parent. Sampled — every finished span is exported — keeping the
   * random-trace-id bit an upstream sent, with the upstream's `tracestate`.
   */
  carrier(traceId: string, spanCounter: number): TraceCarrier | undefined {
    const spanId = formatSpanCounter(spanCounter);
    if (spanId === undefined) return undefined;
    const upstream = this.#upstream.get(traceId);
    const traceparent = formatTraceParent({
      traceId,
      spanId,
      traceFlags: TRACE_FLAG_SAMPLED | ((upstream?.flags ?? 0) & TRACE_FLAG_RANDOM),
    });
    return upstream?.state === undefined ? { traceparent } : { traceparent, tracestate: upstream.state };
  }

  /** A fresh OTel-compatible 16-byte hex trace id. Globally unique, so a trace
   *  stays identifiable once it crosses process boundaries. */
  newTraceId(): string {
    return randomBytes(16).toString("hex");
  }
}

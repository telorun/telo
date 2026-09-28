import { randomBytes } from "node:crypto";
import type { SpanRecord, TraceSinkInstance, Tracer } from "@telorun/sdk";

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

  /** A fresh OTel-compatible 16-byte hex trace id. Globally unique, so a trace
   *  stays identifiable once it crosses process boundaries. */
  newTraceId(): string {
    return randomBytes(16).toString("hex");
  }
}

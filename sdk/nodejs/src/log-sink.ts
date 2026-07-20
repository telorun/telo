import type { LogRecord } from "./log-record.js";

/**
 * The `Telo.Sink` capability contract — `kernel/specs/logging.md` §10.
 *
 * This lives in the SDK rather than the kernel because §10.2 makes the sink set
 * **open to the ecosystem**: a third party ships a sink by publishing a module
 * whose kind extends `Telo.LogSink`. That module is an ordinary module author's
 * artifact, so the contract it implements belongs on the module-author surface,
 * not behind a kernel-internal import.
 *
 * The logger writes to a sink through this contract directly and **never**
 * through `ctx.invoke`: per-record dispatch is far too slow for a logging hot
 * path, and the dispatch chokepoint emits trace events, so logging through it
 * would generate telemetry from inside the telemetry path.
 *
 * The contract is deliberately payload-opaque — no filtering, no encoding —
 * which is what lets a future `Telo.TraceSink` reuse the capability with a
 * different record type. Log-specific configuration lives on the
 * `Telo.LogSink` abstract instead.
 */

export type DropCause = "buffer_full" | "sampled" | "encode_failure" | "sink_error";

/** Policy for a saturated buffer (§10.3). A runtime that cannot honour `block`
 *  rejects the manifest at load rather than silently substituting a dropping
 *  policy. */
export type OnFull = "block" | "drop_new" | "drop_old";

export interface SinkBufferPolicy {
  /** Bounded. Never unbounded. */
  buffer: number;
  onFull: OnFull;
  /** Max time a record may sit buffered, in milliseconds. */
  flushIntervalMs: number;
}

export const DEFAULT_BUFFER_POLICY: SinkBufferPolicy = {
  buffer: 8192,
  onFull: "drop_new",
  flushIntervalMs: 1000,
};

export interface LogSinkInstance {
  /** Identity for drop accounting (§10.4): the resource name for a `!ref`, or
   *  kind plus position for an inline definition. */
  readonly sinkId: string;

  /** This sink's own fan-out filter, applied *after* the record is created. It
   *  never decides whether a record is created at all — that is the pipeline's
   *  minimum-level gate. */
  readonly level: number;

  /**
   * Whether the sink can be drained to its destination from inside a
   * synchronous call, with no scheduler turn. A file descriptor write can; a
   * network round-trip cannot, and neither can a transport living on another
   * thread — the producer cannot drain a queue it does not own.
   *
   * A capability tier, not a language carve-out: the same rule makes an OTLP
   * sink best-effort in Rust and Go, where blocking a producer thread is
   * possible but still would not make a round-trip synchronous.
   */
  readonly syncFlushable: boolean;

  /** Accept a record. MUST NOT throw — a sink failure is reported out-of-band
   *  and counted, never propagated to the caller (§8.4). */
  write(record: LogRecord): void;

  /** Drain asynchronously. */
  flush(): Promise<void>;

  /** Drain to completion before returning. A no-op when {@link syncFlushable}
   *  is `false`; the `fatal` path initiates those sinks' flushes without
   *  waiting, because blocking on a sink it cannot synchronously drain is a
   *  deadlock on an event loop, not durability. */
  flushSync(): void;

  /** Release the destination. Called during teardown, after the final flush. */
  close(): Promise<void>;
}

/**
 * The pipeline surface a sink controller reaches for — attach, detach, resolve a
 * level, count a drop. Deliberately narrow: everything else about the pipeline
 * stays private to the runtime, so a third-party sink depends on this and
 * nothing deeper.
 */
export interface LoggingHost {
  attach(sink: LogSinkInstance): void;
  detach(sink: LogSinkInstance): void;
  /** Resolve a sink's declared `level:` to a severity number, falling back to
   *  the effective scope threshold when the sink declares none (§12.1). */
  levelFor(level: string | undefined): number;
  /** Count `count` dropped records against this sink so §10.4's accounting stays
   *  complete. `count` defaults to 1; a sink that loses a whole batch at once
   *  (an OTLP export failure) passes the batch size so the total is not
   *  undercounted to one-per-failure. */
  recordDrop(sinkId: string, cause: DropCause, count?: number): void;
}

/** The diagnostic §10.3 requires when a runtime cannot honour `on_full: block`.
 *  Rejecting is deliberate: `on_full` exists so an operator can state durability
 *  intent, and silently substituting a dropping policy hands back the opposite
 *  guarantee — discovered from a gap in an audit trail rather than from an
 *  error. */
export function blockUnsupportedMessage(sinkId: string): string {
  return (
    `Sink "${sinkId}": on_full: block is not supported by this runtime ` +
    `(single-threaded event loop — blocking the producer would stall the writer). ` +
    `Use \`drop_new\` or \`drop_old\`, or move this sink to a worker thread.`
  );
}

export const BLOCK_UNSUPPORTED = "ERR_LOG_SINK_ON_FULL_UNSUPPORTED";

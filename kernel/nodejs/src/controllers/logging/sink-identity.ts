import { parseDurationMs } from "@telorun/sdk";
import { blockUnsupportedMessage, DEFAULT_BUFFER_POLICY, type SinkBufferPolicy } from "../../logging/log-sink.js";
import { RuntimeError } from "@telorun/sdk";

/**
 * Shared sink-manifest reading — `kernel/specs/logging.md` §10.3, §12.1.
 */

/** Sink identity for drop accounting (§10.4): the resource name for a `!ref`,
 *  or the synthetic name inline extraction assigned, which already encodes kind
 *  plus position. */
export function sinkIdFor(resource: { metadata?: { name?: string }; kind?: string }): string {
  return resource.metadata?.name ?? resource.kind ?? "<sink>";
}

/**
 * Read the buffering policy an async sink inherits from `Telo.LogSink`.
 *
 * `on_full: block` is rejected here rather than silently degraded. Blocking
 * means suspending the producer until the buffer drains, which requires the
 * drain to progress *while* the producer is suspended — true on a runtime with
 * real threads, false on a single-threaded event loop, where suspending the
 * producer suspends the consumer too. There, `block` is a deadlock.
 *
 * Degrading to `drop_new` would be worse than erroring: someone who writes
 * `block` on an audit sink is saying "I would rather go slow than lose a
 * record", and silently handing back the opposite guarantee means they discover
 * it from a gap in an audit trail rather than from a diagnostic.
 */
export function bufferPolicyFor(resource: {
  metadata?: { name?: string };
  kind?: string;
  buffer?: number;
  on_full?: string;
  flush_interval?: string;
}): SinkBufferPolicy {
  const onFull = resource.on_full ?? DEFAULT_BUFFER_POLICY.onFull;

  if (onFull === "block") {
    throw new RuntimeError(
      "ERR_LOG_SINK_ON_FULL_UNSUPPORTED",
      blockUnsupportedMessage(sinkIdFor(resource)),
    );
  }

  return {
    buffer: resource.buffer ?? DEFAULT_BUFFER_POLICY.buffer,
    onFull: onFull as SinkBufferPolicy["onFull"],
    flushIntervalMs: resource.flush_interval
      ? parseDurationMs(resource.flush_interval, DEFAULT_BUFFER_POLICY.flushIntervalMs)
      : DEFAULT_BUFFER_POLICY.flushIntervalMs,
  };
}

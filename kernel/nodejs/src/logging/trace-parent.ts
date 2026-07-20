import { normalizeSpanId, normalizeTraceId } from "./span-id.js";

/**
 * W3C Trace Context propagation — `kernel/specs/logging.md` §7.4 and §7.5.
 *
 *     traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 *                  ^version ^trace-id (32 hex)          ^parent-id (16)  ^flags
 *
 * Partial adoption of an invalid header is forbidden: a `traceparent` whose
 * trace-id or parent-id is all zeros is ignored *in full* and a new trace is
 * started, rather than salvaging whichever half parsed.
 */

/** Bit 0 — the sampled flag. */
export const TRACE_FLAG_SAMPLED = 0x01;

/**
 * Bit 1 — W3C Trace Context **Level 2**'s random trace-id flag, indicating the
 * right-most 7 bytes of the trace id were chosen randomly, which enables
 * downstream consistent sampling.
 *
 * The bit is *reserved* rather than required to be zero. Level 2 is a Candidate
 * Recommendation, so a runtime preserves the bit when forwarding an inbound
 * header but never sets it itself. Requiring it to be zero — the Level 1
 * reading — would make a conforming runtime corrupt Level 2 traces it merely
 * forwards.
 */
export const TRACE_FLAG_RANDOM = 0x02;

/** Bits 0–1 survive an outgoing request; bits 2–7 are zeroed (§7.5). */
const OUTGOING_FLAG_MASK = TRACE_FLAG_SAMPLED | TRACE_FLAG_RANDOM;

const TRACESTATE_MAX_MEMBERS = 32;
const TRACESTATE_MAX_LENGTH = 512;

export interface TraceContext {
  traceId: string;
  parentSpanId: string;
  traceFlags: number;
  /** Propagated unmodified, or absent when it could not be parsed. Never
   *  partially rewritten. */
  traceState?: string;
}

/**
 * Parse an inbound `traceparent`. Returns `undefined` when the header is absent,
 * malformed, or carries an all-zero id — in every one of those cases the caller
 * starts a fresh trace rather than adopting part of it.
 */
export function parseTraceParent(
  traceparent: string | undefined,
  tracestate?: string | undefined,
): TraceContext | undefined {
  if (!traceparent) return undefined;

  const parts = traceparent.trim().split("-");
  if (parts.length < 4) return undefined;

  const [version, rawTraceId, rawParentId, rawFlags] = parts as [string, string, string, string];

  // Version `ff` is invalid; unknown future versions are parsed leniently, which
  // the spec permits so long as the four known fields validate.
  if (!/^[0-9a-f]{2}$/.test(version) || version === "ff") return undefined;

  const traceId = normalizeTraceId(rawTraceId);
  const parentSpanId = normalizeSpanId(rawParentId);
  if (!traceId || !parentSpanId) return undefined;

  if (!/^[0-9a-f]{2}$/.test(rawFlags)) return undefined;
  const traceFlags = Number.parseInt(rawFlags, 16);

  return {
    traceId,
    parentSpanId,
    traceFlags,
    traceState: parseTraceState(tracestate),
  };
}

/**
 * `tracestate` is propagated unmodified. One that cannot be parsed is discarded
 * in full rather than partially rewritten, so a downstream never receives a
 * mangled header that looks valid.
 */
export function parseTraceState(tracestate: string | undefined): string | undefined {
  if (!tracestate) return undefined;
  const trimmed = tracestate.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > TRACESTATE_MAX_LENGTH) return undefined;
  const members = trimmed.split(",");
  if (members.length > TRACESTATE_MAX_MEMBERS) return undefined;
  for (const member of members) {
    if (member.trim().length === 0) continue;
    if (!member.includes("=")) return undefined;
  }
  return trimmed;
}

/**
 * Serialize an outgoing `traceparent`. Bits 2–7 of the flags are zeroed; bit 1
 * survives only because it arrived that way on an inbound header.
 */
export function formatTraceParent(context: {
  traceId: string;
  spanId: string;
  traceFlags?: number;
}): string {
  const flags = (context.traceFlags ?? 0) & OUTGOING_FLAG_MASK;
  return `00-${context.traceId}-${context.spanId}-${flags.toString(16).padStart(2, "0")}`;
}

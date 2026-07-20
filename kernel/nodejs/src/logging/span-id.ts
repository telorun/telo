import { randomBytes } from "node:crypto";

/**
 * Span and trace identifier formatting — `kernel/specs/logging.md` §7.1 (D7).
 *
 * The internal representation is unconstrained; only the emitted form is
 * normative. Telo keeps span ids as a native counter — minting is an increment,
 * comparison and map-keying stay cheap, nothing allocates — and renders the
 * 16-character hex form **only at the encoding boundary**, on records actually
 * being emitted to a sink that needs it. Ids are never formatted eagerly at span
 * creation.
 *
 * Zero-padding is enforced here rather than left to a caller because it is a
 * live bug class, not a formality: rendering a fixed-width byte array through a
 * general integer formatter silently produces a short, spec-invalid id whenever
 * the value has leading zero bytes.
 */

const SPAN_ID_HEX_LENGTH = 16;
const TRACE_ID_HEX_LENGTH = 32;
const U64_MASK = (1n << 64n) - 1n;

/**
 * An 8-byte per-process salt, minted once at startup. A bare counter starting at
 * 1 collides across processes participating in one distributed trace — two
 * services would both mint span id `1`. XORing costs a single operation,
 * preserves the cheap counter internally, and keeps ids unique within a trace.
 * Span ids carry no randomness requirement of their own (unlike trace ids under
 * W3C Level 2), so a salted counter is sufficient.
 */
const SPAN_ID_SALT = BigInt(`0x${randomBytes(8).toString("hex")}`);

/** Apply the process salt to a raw counter. Bijective, so uniqueness within the
 *  process is preserved exactly. */
export function saltSpanId(counter: number | bigint): bigint {
  return (BigInt(counter) ^ SPAN_ID_SALT) & U64_MASK;
}

/**
 * Render a span id as exactly 16 lowercase hex characters. An all-zero id is
 * invalid and is treated as absent rather than emitted, so this returns
 * `undefined` for zero.
 */
export function formatSpanId(value: bigint | number): string | undefined {
  const masked = BigInt(value) & U64_MASK;
  if (masked === 0n) return undefined;
  return masked.toString(16).padStart(SPAN_ID_HEX_LENGTH, "0");
}

/** Format the salted form of a raw counter — the two steps a record emission
 *  performs together. */
export function formatSpanCounter(counter: number | bigint): string | undefined {
  return formatSpanId(saltSpanId(counter));
}

/**
 * Normalize a trace id for emission: exactly 32 lowercase hex characters. Ids
 * are accepted in either case on ingest and always emitted lowercase. An
 * all-zero or malformed id is treated as absent.
 */
export function normalizeTraceId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lowered = value.toLowerCase();
  if (lowered.length !== TRACE_ID_HEX_LENGTH) return undefined;
  if (!/^[0-9a-f]+$/.test(lowered)) return undefined;
  if (/^0+$/.test(lowered)) return undefined;
  return lowered;
}

/** The `span_id` counterpart of {@link normalizeTraceId}, for ids arriving as
 *  hex from an upstream rather than as a local counter. */
export function normalizeSpanId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lowered = value.toLowerCase();
  if (lowered.length !== SPAN_ID_HEX_LENGTH) return undefined;
  if (!/^[0-9a-f]+$/.test(lowered)) return undefined;
  if (/^0+$/.test(lowered)) return undefined;
  return lowered;
}

/** A fresh W3C-compatible 16-byte trace id. */
export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

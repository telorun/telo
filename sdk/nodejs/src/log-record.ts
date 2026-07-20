import type { SeverityNumber } from "./log-severity.js";

/**
 * The Telo log record model — `kernel/specs/logging.md` §4. Maps 1:1 onto an
 * OpenTelemetry `LogRecord`; encodings (§11) determine spelling and MUST NOT add
 * or remove semantics.
 *
 * The one deliberate deviation from OTel is {@link LogRecord.message}: OTel's
 * `Body` is an `AnyValue` and may be structured, while Telo requires a string and
 * routes structured data to `attributes`. That keeps the console encoding total —
 * every record has a renderable headline — and matches slog, pino, and zap.
 */

/** The attribute value type (§6.1). `null` is a valid value and is preserved. */
export type AnyValue =
  | string
  | boolean
  | number
  | bigint
  | Uint8Array
  | null
  | AnyValue[]
  | { [key: string]: AnyValue };

export type LogAttributes = Record<string, AnyValue>;

/** Structured error (§4.2). The `cause` chain is bounded per §6.3. */
export interface ErrorValue {
  /** Error class or code, e.g. `ERR_INVOKE_CANCELLED`. */
  type: string;
  message: string;
  /** Multi-line, unmodified. */
  stack?: string;
  cause?: ErrorValue;
}

/** The emitting Telo resource (§7.3). `id` is the full hierarchical id, which is
 *  what distinguishes two instances of the same templated kind. */
export interface ResourceRef {
  kind: string;
  name: string;
  id?: string;
}

export interface LogRecord {
  /** Nanoseconds since the Unix epoch, by the origin clock. */
  timestamp: bigint;
  /** When the runtime observed the event, when that differs from `timestamp`
   *  (a bridged third-party logger, §13.3). */
  observedTimestamp?: bigint;
  severityNumber: SeverityNumber;
  /** Canonical short name, or the original source spelling when bridging. */
  severityText: string;
  /** May be empty; never absent. */
  message: string;
  attributes?: LogAttributes;
  /** 32 lowercase hex chars. */
  traceId?: string;
  /** 16 lowercase hex chars. Never present without `traceId`. */
  spanId?: string;
  /** Bit 0 = sampled, bit 1 reserved (§7.5), bits 2–7 zero. */
  traceFlags?: number;
  resource?: ResourceRef;
  /** Module name of the emitter. Not unique — see `scope`. */
  module?: string;
  /** Dotted import-alias path identifying which *instance* emitted the record
   *  (`Api.Domain.Db`). Absent for the root Application's own resources. */
  scope?: string;
  /** Identifies a class of event; max 256 chars. */
  eventName?: string;
  error?: ErrorValue;
  /** Non-zero when §6.3 limits truncated attributes. */
  droppedAttributesCount?: number;
}

// Written as `BigInt(...)` rather than as `1_000_000n` literals: this module is
// consumed from source by the browser-targeted editor, whose tsconfig targets
// below ES2020 and cannot parse the literal syntax.
const NANOS_PER_MS = BigInt(1_000_000);
const NANOS_PER_SECOND = BigInt(1_000_000_000);

/**
 * Node has no true nanosecond wall clock: `Date` is millisecond-resolution and
 * `hrtime.bigint()` is monotonic rather than epoch-anchored. The best available
 * is the performance origin plus the monotonic offset, which yields microsecond
 * resolution zero-padded to nine digits. Format-conformant with §11.1; the extra
 * three digits are always zero.
 *
 * The origin is captured once as a bigint so the addition never routes a
 * 16-significant-digit value through a float64 and loses the low microseconds.
 */
const ORIGIN_NANOS = BigInt(Math.round(performance.timeOrigin * 1e6));

export function nowUnixNano(): bigint {
  return ORIGIN_NANOS + BigInt(Math.round(performance.now() * 1e6));
}

/** Epoch nanoseconds for a millisecond-resolution instant — used when bridging a
 *  third-party record that carries a `Date` or epoch-millis timestamp. */
export function unixNanoFromMillis(epochMillis: number): bigint {
  return BigInt(Math.round(epochMillis)) * NANOS_PER_MS;
}

/**
 * RFC 3339, UTC, nanosecond precision, `Z` suffix — the `time` key of the `json`
 * encoding (§11.1).
 */
export function formatUnixNano(timestamp: bigint): string {
  const seconds = timestamp / NANOS_PER_SECOND;
  const nanos = timestamp - seconds * NANOS_PER_SECOND;
  const isoSeconds = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `${isoSeconds}.${nanos.toString().padStart(9, "0")}Z`;
}

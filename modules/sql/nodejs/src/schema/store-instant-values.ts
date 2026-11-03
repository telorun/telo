import { durationNanos, isCelDuration, isCelTimestamp, timestampNanos } from "@telorun/sdk";

/**
 * The host-side half of the instant members an engine's schema instance renders:
 * reading the `Telo.Duration` / `Telo.Timestamp` a controller was handed, and
 * writing either as the text an engine binds. The arithmetic itself is always the
 * engine's — these only spell a bound value.
 */

const NANOS_PER_SECOND = 1_000_000_000n;

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return `an object (${Object.keys(value).join(", ") || "no keys"})`;
  return `${typeof value} ${String(value)}`;
}

/** The total nanoseconds of a `Telo.Duration` as the SDK hands it to a controller. */
export function storeDurationNanos(value: unknown, describe: string): bigint {
  if (!isCelDuration(value)) {
    throw new TypeError(`${describe} expects a Telo.Duration, got ${describeValue(value)}.`);
  }
  return durationNanos(value);
}

/** The nanoseconds since the epoch of a `Telo.Timestamp` as the SDK hands it to a controller. */
export function storeTimestampNanos(value: unknown, describe: string): bigint {
  if (!isCelTimestamp(value)) {
    throw new TypeError(`${describe} expects a Telo.Timestamp, got ${describeValue(value)}.`);
  }
  return timestampNanos(value);
}

/**
 * Fixed-width UTC text `YYYY-MM-DDTHH:MM:SS.<digits>Z` for an instant, truncated
 * toward the past to `fractionDigits` (1–9). Plain text comparison of two such
 * texts with the same digit count is chronological across years 0000–9999.
 */
export function utcInstantText(nanos: bigint, fractionDigits: number): string {
  let seconds = nanos / NANOS_PER_SECOND;
  let rest = nanos % NANOS_PER_SECOND;
  if (rest < 0n) {
    seconds -= 1n;
    rest += NANOS_PER_SECOND;
  }
  const whole = new Date(Number(seconds) * 1000).toISOString();
  if (!/^\d{4}-/.test(whole)) {
    throw new RangeError(`The instant ${whole} lies outside years 0000–9999 and has no fixed-width text form.`);
  }
  const fraction = rest.toString().padStart(9, "0").slice(0, fractionDigits);
  return `${whole.slice(0, 19)}.${fraction}Z`;
}

/**
 * A signed span of seconds as `±S.<digits>`, truncated toward zero to
 * `fractionDigits` (1–9).
 */
export function signedSecondsText(nanos: bigint, fractionDigits: number): string {
  const sign = nanos < 0n ? "-" : "+";
  const magnitude = nanos < 0n ? -nanos : nanos;
  const fraction = (magnitude % NANOS_PER_SECOND).toString().padStart(9, "0").slice(0, fractionDigits);
  return `${sign}${magnitude / NANOS_PER_SECOND}.${fraction}`;
}

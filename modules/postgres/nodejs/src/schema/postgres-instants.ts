import type { CelDuration, CelTimestamp } from "@telorun/sdk";
import {
  signedSecondsText,
  SqlFragments,
  storeDurationNanos,
  storeTimestampNanos,
  utcInstantText,
} from "@telorun/sql";

/**
 * How `Postgres.Schema` writes instants and row selections. An instant is a
 * `timestamptz`, to the microsecond.
 */

const NANOS_PER_HOUR = 3_600_000_000_000n;

/** `clock_timestamp()` rather than `now()`: the latter is the transaction's
 *  start, so two statements of one transaction would record one instant. */
export function postgresCurrentInstant(): string {
  return "clock_timestamp()";
}

/**
 * The current instant plus an interval cast from bound text,
 * `±H hours ±S.uuuuuu seconds`, the duration truncated toward zero to the
 * microsecond. Hours and seconds both land in the interval's time part, so the
 * shift is exact elapsed time — never calendar days, which `timestamptz`
 * arithmetic would move across a daylight-saving change — and splitting at the
 * hour keeps each field within what every server version parses.
 */
export function postgresCurrentInstantPlus(duration: CelDuration, describe: string): SqlFragments {
  const nanos = storeDurationNanos(duration, `${describe}: currentInstantPlus`);
  const sign = nanos < 0n ? "-" : "+";
  const magnitude = nanos < 0n ? -nanos : nanos;
  const hours = magnitude / NANOS_PER_HOUR;
  const seconds = signedSecondsText(magnitude % NANOS_PER_HOUR, 6).slice(1);
  return new SqlFragments()
    .text(`(${postgresCurrentInstant()} + CAST(`)
    .value(`${sign}${hours} hours ${sign}${seconds} seconds`)
    .text(" AS interval))");
}

/** A bound instant cast from UTC text, truncated toward the past to the
 *  microsecond. */
export function postgresInstantParameter(timestamp: CelTimestamp, describe: string): SqlFragments {
  const nanos = storeTimestampNanos(timestamp, `${describe}: instantParameter`);
  return new SqlFragments().text("CAST(").value(utcInstantText(nanos, 6)).text(" AS timestamptz)");
}

/** Rows another open transaction has locked are passed over rather than
 *  waited for, and the rows selected are locked until this transaction ends. */
export const POSTGRES_SKIP_LOCKED_CLAUSE = "FOR UPDATE SKIP LOCKED";

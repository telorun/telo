import type { CelDuration, CelTimestamp } from "@telorun/sdk";
import {
  signedSecondsText,
  SqlFragments,
  storeDurationNanos,
  storeTimestampNanos,
  utcInstantText,
} from "@telorun/sql";

/**
 * How `SQLite.Schema` writes instants and row selections. SQLite has no
 * timestamp type: an instant is fixed-width UTC text (`YYYY-MM-DDTHH:MM:SS.sssZ`),
 * so plain text comparison is chronological, and its clock and its arithmetic
 * are both to the millisecond.
 */

const INSTANT_FORMAT = "'%Y-%m-%dT%H:%M:%fZ'";

/** The first and last millisecond SQLite's date functions represent; outside
 *  them they answer NULL rather than an error. */
const FIRST_MILLIS = BigInt(Date.parse("0000-01-01T00:00:00.000Z"));
const LAST_MILLIS = BigInt(Date.parse("9999-12-31T23:59:59.999Z"));

const NANOS_PER_MILLI = 1_000_000n;

export function sqliteCurrentInstant(): string {
  return `strftime(${INSTANT_FORMAT}, 'now')`;
}

/**
 * The current instant shifted by a bound date modifier (`±S.sss seconds`) —
 * SQLite's own arithmetic over its own clock, the duration truncated toward
 * zero to the millisecond. SQLite answers NULL for a result outside years
 * 0000–9999 instead of failing, so such a shift is refused here; the database
 * is embedded, so its clock is this process's and the bound is exact.
 */
export function sqliteCurrentInstantPlus(duration: CelDuration, describe: string): SqlFragments {
  const nanos = storeDurationNanos(duration, `${describe}: currentInstantPlus`);
  const shifted = BigInt(Date.now()) + nanos / NANOS_PER_MILLI;
  if (shifted < FIRST_MILLIS || shifted > LAST_MILLIS) {
    throw new RangeError(
      `${describe}: currentInstantPlus: shifting the current instant by ` +
        `${signedSecondsText(nanos, 9)}s leaves years 0000–9999, the range SQLite's date ` +
        `functions represent.`,
    );
  }
  return new SqlFragments()
    .text(`strftime(${INSTANT_FORMAT}, 'now', `)
    .value(`${signedSecondsText(nanos, 3)} seconds`)
    .text(")");
}

/** A bound instant in the column's text form, truncated toward the past to the
 *  millisecond. */
export function sqliteInstantParameter(timestamp: CelTimestamp, describe: string): SqlFragments {
  const nanos = storeTimestampNanos(timestamp, `${describe}: instantParameter`);
  return new SqlFragments().value(utcInstantText(nanos, 3));
}

/** SQLite has one writer per database: a transaction that writes holds the
 *  whole file until it ends, so there is no row lock to skip and a selection
 *  needs no clause. */
export const SQLITE_SKIP_LOCKED_CLAUSE = "";

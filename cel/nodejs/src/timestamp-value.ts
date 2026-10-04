/**
 * Instants: reading one, writing one, and reading a field of one in a time zone.
 *
 * A timestamp is whole seconds plus nanoseconds in `[0, 1e9)`, because cel-spec's own
 * rows carry nanosecond instants (`string(timestamp('9999-12-31T23:59:59.999999999Z'))`)
 * and no host date type holds them. The range is cel-spec's: `0001-01-01T00:00:00Z`
 * through `9999-12-31T23:59:59.999999999Z`, and an instant outside it is an error
 * wherever it would be built — which is exactly the answer the vectors call
 * domain-keeping where the engine being replaced returns a date beyond year 9999.
 *
 * **A zone is named, never computed here.** A getter takes an IANA name or a fixed
 * `±HH:MM` offset; the rules behind a name are the host's data, which no release of this
 * engine fixes, so the only thing this file decides is how a name is applied.
 */

import {
  celError,
  CEL_VALUE_TYPE,
  isCelError,
  type CelError,
  type CelTimestamp,
} from "./cel-value.js";
import type { SourceRange } from "./syntax-tree.js";

/** `0001-01-01T00:00:00Z` and `9999-12-31T23:59:59Z`, in seconds since the epoch. */
export const MIN_TIMESTAMP_SECONDS = -62135596800n;
export const MAX_TIMESTAMP_SECONDS = 253402300799n;

const NANOS_PER_SECOND = 1_000_000_000n;

/** An instant from seconds and nanoseconds of any sign, normalized, or the range error. */
export function celTimestamp(
  seconds: bigint,
  nanos: bigint | number = 0,
  range?: SourceRange,
): CelTimestamp | CelError {
  const total = BigInt(nanos);
  let whole = seconds + total / NANOS_PER_SECOND;
  let rest = total % NANOS_PER_SECOND;
  if (rest < 0n) {
    whole -= 1n;
    rest += NANOS_PER_SECOND;
  }
  if (whole < MIN_TIMESTAMP_SECONDS || whole > MAX_TIMESTAMP_SECONDS) {
    return celError("invalid_conversion", "timestamp out of range", range);
  }
  return { [CEL_VALUE_TYPE]: "google.protobuf.Timestamp", seconds: whole, nanos: Number(rest) };
}

/**
 * An instant from epoch MILLISECONDS — the mirror of `celDurationFromNanos` for a host
 * clock reading (`Date.now()`, a driver's epoch-millis column), or the range error.
 *
 * It exists so that a host never has to reach for its own date type to say "now": the
 * instance type is seconds plus nanos, and a millisecond reading is the one other shape
 * a host actually holds. A fractional reading keeps its sub-millisecond part.
 */
export function celTimestampFromMillis(millis: number, range?: SourceRange): CelTimestamp | CelError {
  if (!Number.isFinite(millis)) {
    return celError("invalid_conversion", "timestamp out of range", range);
  }
  const whole = Math.floor(millis / 1000);
  return celTimestamp(BigInt(whole), Math.round((millis - whole * 1000) * 1_000_000), range);
}

/** The instant's nanoseconds since the epoch — what arithmetic and ordering compare. */
export function timestampNanos(value: CelTimestamp): bigint {
  return value.seconds * NANOS_PER_SECOND + BigInt(value.nanos);
}

const RFC_3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/** An instant from RFC 3339 text, with any offset and any fractional precision. */
export function parseTimestamp(text: string, range?: SourceRange): CelTimestamp | CelError {
  const parts = RFC_3339.exec(text);
  if (!parts) {
    return celError("invalid_conversion", `${JSON.stringify(text)} is not an RFC 3339 instant`, range);
  }
  const [, year, month, day, hour, minute, second, fraction, sign, offsetHours, offsetMinutes] = parts;
  const fields = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
  if (
    fields.month < 1 ||
    fields.month > 12 ||
    fields.day < 1 ||
    fields.day > daysInMonth(fields.year, fields.month) ||
    fields.hour > 23 ||
    fields.minute > 59 ||
    fields.second > 59
  ) {
    return celError("invalid_conversion", `${JSON.stringify(text)} is not an instant`, range);
  }
  let seconds = secondsFromFields(fields);
  if (sign) {
    const offset = BigInt(Number(offsetHours) * 3600 + Number(offsetMinutes) * 60);
    seconds += sign === "-" ? offset : -offset;
  }
  const nanos = fraction ? Number(`${fraction}000000000`.slice(0, 9)) : 0;
  return celTimestamp(seconds, nanos, range);
}

/**
 * RFC 3339 in UTC, with the fraction written to the precision it carries and omitted
 * when the instant is whole — cel-spec's own spelling (`2009-02-13T23:31:30Z`).
 */
export function formatTimestamp(value: CelTimestamp): string {
  const fields = utcFields(value.seconds);
  const date = `${pad(fields.year, 4)}-${pad(fields.month, 2)}-${pad(fields.day, 2)}`;
  const time = `${pad(fields.hour, 2)}:${pad(fields.minute, 2)}:${pad(fields.second, 2)}`;
  return `${date}T${time}${fractionText(value.nanos)}Z`;
}

function fractionText(nanos: number): string {
  if (nanos === 0) return "";
  return `.${pad(nanos, 9).replace(/0+$/, "")}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

// --- the calendar ----------------------------------------------------------

export interface CivilFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1]!;
}

/** Days from the epoch to a civil date, by Howard Hinnant's `days_from_civil`. */
function daysFromCivil(year: number, month: number, day: number): number {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The civil date a day count names, the inverse of `daysFromCivil`. */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  return { year: month <= 2 ? year + 1 : year, month, day };
}

function secondsFromFields(fields: CivilFields): bigint {
  const days = daysFromCivil(fields.year, fields.month, fields.day);
  return BigInt(days) * 86400n + BigInt(fields.hour * 3600 + fields.minute * 60 + fields.second);
}

function utcFields(seconds: bigint): CivilFields {
  const days = Number(floorDiv(seconds, 86400n));
  const rest = Number(seconds - BigInt(days) * 86400n);
  const date = civilFromDays(days);
  return {
    ...date,
    hour: Math.floor(rest / 3600),
    minute: Math.floor((rest % 3600) / 60),
    second: rest % 60,
  };
}

function floorDiv(value: bigint, by: bigint): bigint {
  const quotient = value / by;
  return value % by < 0n ? quotient - 1n : quotient;
}

// --- zones -----------------------------------------------------------------

const FIXED_OFFSET = /^([+-]?)(\d{2}):(\d{2})$/;

/**
 * The civil fields of an instant in a zone. A zone is an IANA name, resolved by the
 * host's own tz database, or a fixed `±HH:MM` offset, which is arithmetic; an unsigned
 * offset is read as ahead of UTC, as cel-spec's own rows read it.
 */
export function zonedFields(
  value: CelTimestamp,
  zone: string | undefined,
  range?: SourceRange,
): CivilFields | CelError {
  if (zone === undefined || zone === "UTC") return utcFields(value.seconds);
  const fixed = FIXED_OFFSET.exec(zone);
  if (fixed) {
    const [, sign, hours, minutes] = fixed;
    if (Number(hours) > 23 || Number(minutes) > 59) {
      return celError("invalid_argument", `${JSON.stringify(zone)} is not a time zone`, range);
    }
    const offset = BigInt(Number(hours) * 3600 + Number(minutes) * 60);
    return utcFields(value.seconds + (sign === "-" ? -offset : offset));
  }
  return namedZoneFields(value, zone, range);
}

/** The host's answer for an IANA zone. Its rules are the host's data, not this engine's. */
function namedZoneFields(
  value: CelTimestamp,
  zone: string,
  range?: SourceRange,
): CivilFields | CelError {
  let parts: Intl.DateTimeFormatPart[];
  try {
    const format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      era: "short",
    });
    parts = format.formatToParts(new Date(Number(value.seconds) * 1000));
  } catch {
    return celError("invalid_argument", `${JSON.stringify(zone)} is not a time zone`, range);
  }
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  const era = parts.find((part) => part.type === "era")?.value;
  const year = read("year");
  return {
    year: era === "BC" ? 1 - year : year,
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** Which field of an instant a getter answers. The names are cel-spec's. */
export type TimestampField =
  | "getFullYear"
  | "getMonth"
  | "getDayOfYear"
  | "getDayOfMonth"
  | "getDate"
  | "getDayOfWeek"
  | "getHours"
  | "getMinutes"
  | "getSeconds"
  | "getMilliseconds";

/**
 * A field of an instant. `getMonth`, `getDayOfMonth` and `getDayOfYear` are **zero
 * based** and `getDate` is one based, which is cel-spec's own split; `getDayOfWeek`
 * counts from Sunday.
 */
export function timestampField(
  value: CelTimestamp,
  field: TimestampField,
  zone?: string,
  range?: SourceRange,
): bigint | CelError {
  if (field === "getMilliseconds") return BigInt(Math.floor(value.nanos / 1_000_000));
  const civil = zonedFields(value, zone, range);
  if (isCelError(civil)) return civil;
  switch (field) {
    case "getFullYear":
      return BigInt(civil.year);
    case "getMonth":
      return BigInt(civil.month - 1);
    case "getDayOfMonth":
      return BigInt(civil.day - 1);
    case "getDate":
      return BigInt(civil.day);
    case "getDayOfYear":
      return BigInt(daysFromCivil(civil.year, civil.month, civil.day) - daysFromCivil(civil.year, 1, 1));
    case "getDayOfWeek": {
      const days = daysFromCivil(civil.year, civil.month, civil.day);
      return BigInt(((days % 7) + 11) % 7);
    }
    case "getHours":
      return BigInt(civil.hour);
    case "getMinutes":
      return BigInt(civil.minute);
    case "getSeconds":
      return BigInt(civil.second);
  }
}

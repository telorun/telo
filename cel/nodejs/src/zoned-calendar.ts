/**
 * The calendar in a time zone: an instant's wall-clock fields, and the instant a wall
 * clock names.
 *
 * An instant is only a date once a zone is chosen, so every calendar function of the
 * function catalog reads its fields through here. The zone's RULES are the host's data
 * (`Intl.DateTimeFormat`, ECMA-402, present in a browser as in Node), never this
 * engine's: what is written here is only how those rules are applied, which is the half
 * a second engine has to reproduce.
 *
 * It is separate from `timestamp-value.ts` on purpose. That file is the language's own
 * zone reading — cel-spec's getters, which also accept a fixed `HH:MM` offset and word
 * their refusal as the language does. This one is the catalog's: it accepts an IANA name
 * alone, it is millisecond-granular because the functions built on it render
 * milliseconds, and it answers a gap or a repeated wall clock the way a calendar
 * library does. Folding the two would make one of the two behaviours wrong.
 */

/** A wall clock, to the second: what a zone makes of an instant. */
export interface CivilTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Whether the host knows the zone. The catalog's refusal is worded by its caller, so
 * this answers only yes or no — left to `Intl` the failure is a `RangeError` naming
 * neither the function nor what was wrong with the argument.
 */
export function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const FIELD_OPTIONS: Intl.DateTimeFormatOptions = {
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

function zoneParts(
  instant: number,
  zone: string,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options }).formatToParts(
    new Date(instant),
  )) {
    parts[part.type] = part.value;
  }
  return parts;
}

/** The wall clock an instant reads as in a zone. */
export function civilTimeIn(instant: number, zone: string): CivilTime {
  const parts = zoneParts(instant, zone, FIELD_OPTIONS);
  return {
    year: +parts.year!,
    month: +parts.month!,
    day: +parts.day!,
    hour: +parts.hour!,
    minute: +parts.minute!,
    second: +parts.second!,
  };
}

/** The zone's offset at an instant, in milliseconds: its wall clock read as UTC, minus it. */
function offsetAt(instant: number, zone: string): number {
  const fields = civilTimeIn(instant, zone);
  return (
    Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second) -
    instant
  );
}

function sameWallClock(left: CivilTime, right: CivilTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

/**
 * The instant whose wall clock in `zone` is these fields.
 *
 * The offset depends on the instant being solved for, so this takes the offset at the
 * UTC reading, corrects, and then **checks** by reading the result back. That check is
 * the whole point: a plain fixpoint settles on an instant whose wall clock is not the one
 * asked for whenever the requested time does not exist, and it settles BACKWARDS — which
 * silently moves the calendar day, the one thing `addMonths` and `startOfMonth` exist to
 * control. Chile jumps 00:00 to 01:00 on 2026-09-06 and Cuba on 2026-03-08, so "the 6th
 * at midnight" there is not a time; a fixpoint answered "the 5th at 23:00".
 *
 * Resolution follows Java's `ZonedDateTime` and Temporal's `compatible`: a wall clock
 * that exists twice (a fall-back) takes the EARLIER instant, and one that does not exist
 * (a spring-forward gap) shifts FORWARD out of the gap, which keeps the requested day.
 */
export function instantOfCivilTime(fields: CivilTime, zone: string): number {
  const asUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  const offsetA = offsetAt(asUtc, zone);
  const candidateA = asUtc - offsetA;
  const offsetB = offsetAt(candidateA, zone);
  if (offsetA === offsetB) return candidateA;

  const candidateB = asUtc - offsetB;
  const aHolds = sameWallClock(civilTimeIn(candidateA, zone), fields);
  const bHolds = sameWallClock(civilTimeIn(candidateB, zone), fields);
  if (aHolds && bHolds) return Math.min(candidateA, candidateB);
  if (aHolds) return candidateA;
  if (bHolds) return candidateB;
  return Math.max(candidateA, candidateB);
}

/** `Date.UTC` maps years 0-99 to 1900-1999, so the year is set explicitly. */
export function daysInMonth(year: number, month: number): number {
  const date = new Date(Date.UTC(2000, month, 0));
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** The calendar date (`YYYY-MM-DD`) an instant reads as in a zone. */
export function dateTextIn(instant: number, zone: string): string {
  if (zone === "UTC" || zone === "Z") return new Date(instant).toISOString().slice(0, 10);
  const parts = zoneParts(instant, zone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * An instant as ISO-8601 in a zone, with milliseconds: UTC as `…Z`, else the zone's own
 * offset (`2026-06-06T18:30:00.000-05:00`). The offset is derived arithmetically from
 * standard `Intl` fields, so nothing here needs a newer ECMA-402 surface.
 */
export function isoTextIn(instant: number, zone: string): string {
  if (zone === "UTC" || zone === "Z") return new Date(instant).toISOString();
  const fields = civilTimeIn(instant, zone);
  // Sub-second is zone-independent; read it off the instant directly.
  const milliseconds = pad(((instant % 1000) + 1000) % 1000, 3);
  const minutes = Math.round(
    (Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second) -
      instant) /
      60000,
  );
  const offset =
    minutes === 0
      ? "Z"
      : `${minutes > 0 ? "+" : "-"}${pad(Math.floor(Math.abs(minutes) / 60), 2)}:${pad(Math.abs(minutes) % 60, 2)}`;
  const date = `${pad(fields.year, 4)}-${pad(fields.month, 2)}-${pad(fields.day, 2)}`;
  const time = `${pad(fields.hour, 2)}:${pad(fields.minute, 2)}:${pad(fields.second, 2)}`;
  return `${date}T${time}.${milliseconds}${offset}`;
}

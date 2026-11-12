import { dayText } from "./date-range.js";

/** A filter value relative to now, as the page document carries it: now moved by `offset` units. */
export interface RelativeValue {
  unit: "minute" | "hour" | "day" | "week" | "month" | "year";
  offset: number;
}

/** The two formats a relative value resolves to: the instant, or that moment's date. */
export type RelativeFormat = "date" | "date-time";

/** `now<sign><count><unit>`: how a bar holds a relative value — in its state, the address and a store. */
const SPELLING = /^now([+-])(\d+)(minute|hour|day|week|month|year)$/;

export const isRelativeValue = (value: unknown): value is RelativeValue =>
  value !== null && typeof value === "object" && "unit" in value && "offset" in value;

/** A relative value as a bar holds it: `now-1day`, `now+2week`, `now+0hour`. */
export const spellRelative = (value: RelativeValue): string => `now${value.offset < 0 ? "-" : "+"}${Math.abs(value.offset)}${value.unit}`;

/** The relative value a bar's text spells, or nothing when it spells none. */
export function readRelative(text: string): RelativeValue | undefined {
  const match = SPELLING.exec(text);
  if (!match) return undefined;
  const count = Number(match[2]);
  return { unit: match[3] as RelativeValue["unit"], offset: match[1] === "-" ? -count : count };
}

/** The format a filter's property gives a relative value, or nothing when it takes none. */
export function relativeFormat(schema: { format?: unknown }, operator: string): RelativeFormat | undefined {
  const takes = operator === "eq" || operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte";
  return takes && (schema.format === "date" || schema.format === "date-time") ? schema.format : undefined;
}

/** A date moved by whole months in the viewer's time zone, its day held to the target month's last. */
function movedMonths(from: Date, months: number): Date {
  const moved = new Date(from.getTime());
  const day = from.getDate();
  moved.setDate(1);
  moved.setMonth(moved.getMonth() + months);
  const last = new Date(moved.getFullYear(), moved.getMonth() + 1, 0).getDate();
  moved.setDate(Math.min(day, last));
  return moved;
}

/**
 * A relative value at `now`, in the viewer's time zone: minutes and hours as
 * elapsed time, days and weeks as calendar days, months and years as calendar
 * months with the day held to the month's last. The instant for `date-time`,
 * that moment's date for `date`.
 */
export function resolveRelative(value: RelativeValue, format: RelativeFormat, now: Date): string {
  let moved: Date;
  switch (value.unit) {
    case "minute":
      moved = new Date(now.getTime() + value.offset * 60_000);
      break;
    case "hour":
      moved = new Date(now.getTime() + value.offset * 3_600_000);
      break;
    case "day":
    case "week":
      moved = new Date(now.getTime());
      moved.setDate(moved.getDate() + value.offset * (value.unit === "week" ? 7 : 1));
      break;
    case "month":
      moved = movedMonths(now, value.offset);
      break;
    case "year":
      moved = movedMonths(now, value.offset * 12);
      break;
  }
  return format === "date" ? dayText(moved) : moved.toISOString();
}

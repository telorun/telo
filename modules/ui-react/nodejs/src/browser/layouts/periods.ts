import type { LayoutPeriod } from "../../contract/ui-react-layouts.js";

/**
 * Days as whole numbers since 1970-01-01 in UTC, and the periods a calendar or
 * a timeline shows over them. A `date` value is its day; a `date-time` value
 * the UTC day it falls on.
 */

const DAY = 86_400_000;

export type SpanFormat = "date" | "date-time";

/** The day a value falls on, or `undefined` when it holds no date. */
export function dayOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : Math.floor(time / DAY);
}

export const today = (): number => Math.floor(Date.now() / DAY);

/** A day as a `date`: `YYYY-MM-DD`. */
export const dayText = (day: number): string => new Date(day * DAY).toISOString().slice(0, 10);

/** A day as a value of the span's format: a `date-time` at the day's first second, or its last, in UTC. */
export function written(day: number, format: SpanFormat, last = false): string {
  if (format === "date") return dayText(day);
  return `${dayText(day)}T${last ? "23:59:59" : "00:00:00"}Z`;
}

/** A period's bounds as the plan's `span` sends them. */
export const periodOf = (first: number, last: number, format: SpanFormat): LayoutPeriod => ({ from: written(first, format), to: written(last, format, true) });

/** The value moved by whole days, its time of day kept. */
export function shifted(value: string, days: number, format: SpanFormat): string {
  if (format === "date") return dayText((dayOf(value) as number) + days);
  return new Date(Date.parse(value) + days * DAY).toISOString();
}

const parts = (day: number) => {
  const date = new Date(day * DAY);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), weekday: (date.getUTCDay() + 6) % 7 };
};
const dayAt = (year: number, month: number, date = 1) => Math.floor(Date.UTC(year, month, date) / DAY);

/** The Monday of the week holding a day. */
export const weekOf = (day: number): number => day - parts(day).weekday;
/** The weekday of a day, Monday first. */
export const weekdayOf = (day: number): number => parts(day).weekday;

export type CalendarView = "month" | "week" | "day";
export type TimelineScale = "day" | "week" | "month" | "quarter";

/** The days a calendar shows around a day: its month, its week, or the day. */
export function calendarPeriod(view: CalendarView, day: number): { first: number; last: number } {
  if (view === "day") return { first: day, last: day };
  if (view === "week") return { first: weekOf(day), last: weekOf(day) + 6 };
  const { year, month } = parts(day);
  return { first: dayAt(year, month), last: dayAt(year, month + 1) - 1 };
}

/** The period before or after the one holding a day. */
export function calendarStep(view: CalendarView, day: number, by: -1 | 1): number {
  if (view === "day") return day + by;
  if (view === "week") return weekOf(day) + 7 * by;
  const { year, month } = parts(day);
  return dayAt(year, month + by);
}

/** One column of a timeline: the days it spans. */
export interface Tick {
  first: number;
  last: number;
}

/**
 * The columns a timeline shows around a day, at its scale: the days of its
 * month, the weeks of its quarter — the first and the last cut at the
 * quarter's bounds — the months of its year, or the quarters of three years
 * from its year.
 */
export function timelineTicks(scale: TimelineScale, day: number): Tick[] {
  const { year, month } = parts(day);
  if (scale === "day") {
    const first = dayAt(year, month);
    return Array.from({ length: dayAt(year, month + 1) - first }, (_, index) => ({ first: first + index, last: first + index }));
  }
  if (scale === "week") {
    const quarter = month - (month % 3);
    const begin = dayAt(year, quarter);
    const end = dayAt(year, quarter + 3) - 1;
    const ticks: Tick[] = [];
    for (let at = weekOf(begin); at <= end; at += 7) ticks.push({ first: Math.max(at, begin), last: Math.min(at + 6, end) });
    return ticks;
  }
  if (scale === "month") return Array.from({ length: 12 }, (_, index) => ({ first: dayAt(year, index), last: dayAt(year, index + 1) - 1 }));
  return Array.from({ length: 12 }, (_, index) => ({ first: dayAt(year, index * 3), last: dayAt(year, index * 3 + 3) - 1 }));
}

/** A day in the period before or after the one a timeline shows. */
export function timelineStep(scale: TimelineScale, day: number, by: -1 | 1): number {
  const { year, month } = parts(day);
  if (scale === "day") return dayAt(year, month + by);
  if (scale === "week") return dayAt(year, month - (month % 3) + 3 * by);
  return dayAt(year + by * (scale === "month" ? 1 : 3), 0);
}

/** A formatter of days in the page's language, in UTC. */
export function dayFormat(lang: string, options: Intl.DateTimeFormatOptions) {
  const format = new Intl.DateTimeFormat([lang, "en"], { ...options, timeZone: "UTC" });
  return {
    day: (day: number) => format.format(new Date(day * DAY)),
    range: (first: number, last: number) => (first === last ? format.format(new Date(first * DAY)) : format.formatRange(new Date(first * DAY), new Date(last * DAY))),
  };
}

/** The name of a unit of time in the page's language: `month`, `week`, `day`, `quarter`. */
export function unitName(lang: string, unit: CalendarView | TimelineScale): string {
  return new Intl.DisplayNames([lang, "en"], { type: "dateTimeField" }).of(unit === "week" ? "weekOfYear" : unit) ?? unit;
}

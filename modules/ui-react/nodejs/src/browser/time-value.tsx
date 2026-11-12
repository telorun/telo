import { useContext, useState, type ReactNode } from "react";
import { RendererContext, VisibleContext } from "./renderer-context.js";
import { useReloadEvery } from "./timed-reload.js";

/** A date or a date-time as the text it was read from, or nothing when the text is neither. */
type Moment = { format: "date"; year: number; month: number; day: number; text: string } | { format: "date-time"; at: Date };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?$/;

/** What a string is by its own shape: a calendar date, an instant, or neither. */
function momentOf(value: unknown): Moment | undefined {
  if (typeof value !== "string") return undefined;
  const date = DATE.exec(value);
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const check = new Date(Date.UTC(year, month - 1, day));
    return check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? { format: "date", year, month, day, text: value } : undefined;
  }
  if (!DATE_TIME.test(value)) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : { format: "date-time", at };
}

/** The locales a document's language reads in: the viewer's own for `und`. */
const locales = (lang: string): string[] | undefined => (lang === "und" ? undefined : [lang]);

/** The moment as an absolute date, or date and time, in the viewer's language and time zone; `seconds` for the exact time. */
function absoluteText(moment: Moment, lang: string, seconds: boolean): string {
  if (moment.format === "date") {
    return new Intl.DateTimeFormat(locales(lang), { dateStyle: "medium", timeZone: "UTC" }).format(new Date(Date.UTC(moment.year, moment.month - 1, moment.day)));
  }
  return new Intl.DateTimeFormat(locales(lang), { dateStyle: "medium", timeStyle: seconds ? "medium" : "short" }).format(moment.at);
}

const DAY = 86_400_000;

/** How far a span of days is, in the largest unit that reads it: days, weeks, months, years. */
function daysText(days: number, format: Intl.RelativeTimeFormat): string {
  if (Math.abs(days) < 7) return format.format(days, "day");
  if (Math.abs(days) < 30) return format.format(Math.round(days / 7), "week");
  const months = Math.round(days / 30.44);
  if (Math.abs(months) < 12) return format.format(months, "month");
  return format.format(Math.round(days / 365.25), "year");
}

/** The moment relative to `now` in the viewer's language: "3 hours ago", "yesterday", "in 2 weeks". */
function relativeText(moment: Moment, now: number, lang: string): string {
  const format = new Intl.RelativeTimeFormat(locales(lang), { numeric: "auto" });
  if (moment.format === "date") {
    const today = new Date(now);
    const days = Math.round((Date.UTC(moment.year, moment.month - 1, moment.day) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / DAY);
    return daysText(days, format);
  }
  const seconds = (moment.at.getTime() - now) / 1000;
  if (Math.abs(seconds) < 60) return format.format(0, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(seconds / 3600);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return daysText(Math.round(seconds / 86_400), format);
}

/** How often a relative time is drawn again while it is shown. */
const REFRESH_MS = 60_000;

/**
 * A date or a date-time, as a `time` node and a time column draw it: relative
 * to now with the exact time as its tooltip, drawn again every minute while it
 * is shown and the document is visible, or absolute. Its `datetime` carries
 * the machine-readable time. A string that is no date is drawn as plain text,
 * and nothing as nothing.
 */
export function TimeValue({ value, relative, fill, style }: { value: unknown; relative: boolean; fill?: boolean; style?: string }): ReactNode {
  const { lang } = useContext(RendererContext);
  const visible = useContext(VisibleContext);
  const [, redraw] = useState(0);
  const moment = momentOf(value);
  useReloadEvery(REFRESH_MS, relative && moment !== undefined && visible, () => false, () => redraw((count) => count + 1));
  if (value === undefined || value === null) return null;
  if (!moment) {
    return (
      <span data-telo-part="time" data-fill={fill ? "true" : undefined} data-style={style}>
        {typeof value === "object" ? JSON.stringify(value) : String(value)}
      </span>
    );
  }
  const machine = moment.format === "date" ? moment.text : moment.at.toISOString();
  return (
    <time
      data-telo-part="time"
      data-fill={fill ? "true" : undefined}
      data-style={style}
      dateTime={machine}
      title={relative ? absoluteText(moment, lang, true) : undefined}
    >
      {relative ? relativeText(moment, Date.now(), lang) : absoluteText(moment, lang, false)}
    </time>
  );
}

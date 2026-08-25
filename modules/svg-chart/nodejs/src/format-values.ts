import { formatLocale, type FormatLocaleDefinition } from "d3-format";
import { timeFormatLocale, type TimeLocaleDefinition } from "d3-time-format";

/**
 * Number and date formatting, per chart, in the declared locale.
 *
 * Built through d3's own locale CONSTRUCTORS rather than its default-locale
 * setters: the setters are process-global, so one chart's locale would decide
 * the next chart's, and there is no honest way to put the previous one back —
 * they return the locale's API, not the definition that produced it.
 *
 * The definitions come from `Intl.NumberFormat` / `Intl.DateTimeFormat`, so no
 * locale table ships with the module and any tag the platform knows works.
 */

const localeCache = new Map<
  string,
  { number: ReturnType<typeof formatLocale>; time: ReturnType<typeof timeFormatLocale> }
>();

function localeFor(locale: string) {
  let cached = localeCache.get(locale);
  if (!cached) {
    cached = { number: formatLocale(numberLocale(locale)), time: timeFormatLocale(timeLocale(locale)) };
    localeCache.set(locale, cached);
  }
  return cached;
}

function numberLocale(locale: string): FormatLocaleDefinition {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const currency = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" })
    .formatToParts(1)
    .find((part) => part.type === "currency")?.value;
  return {
    decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
    thousands: parts.find((part) => part.type === "group")?.value ?? ",",
    grouping: [3],
    currency: [currency ?? "$", ""],
    minus: "−",
  };
}

function timeLocale(locale: string): TimeLocaleDefinition {
  // d3-time-format's definition is fixed-length, so the tuple shape is asserted
  // where the arrays are built rather than at each of the four uses.
  const months = (style: "long" | "short") => {
    const fmt = new Intl.DateTimeFormat(locale, { month: style, timeZone: "UTC" });
    return Array.from({ length: 12 }, (_, month) =>
      fmt.format(Date.UTC(2021, month, 1)),
    ) as TimeLocaleDefinition["months"];
  };
  const days = (style: "long" | "short") => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" });
    // 2021-08-01 was a Sunday, which is where d3 starts its week.
    return Array.from({ length: 7 }, (_, day) =>
      fmt.format(Date.UTC(2021, 7, 1 + day)),
    ) as TimeLocaleDefinition["days"];
  };
  return {
    dateTime: "%x, %X",
    date: "%-m/%-d/%Y",
    time: "%-I:%M:%S %p",
    periods: ["AM", "PM"],
    days: days("long"),
    shortDays: days("short"),
    months: months("long"),
    shortMonths: months("short"),
  };
}

export type Formatter = (value: number) => string;

/** A number formatter for `specifier`, or a general one that drops trailing
 *  zeros — which is what makes an axis of 0, 2.5, 5 read as written instead of
 *  as 0.0000, 2.5000. */
export function numberFormatter(specifier: string | undefined, locale: string): Formatter {
  const { number } = localeFor(locale);
  if (specifier) return number.format(specifier);
  const general = number.format(",");
  const fractional = number.format(",.2~f");
  return (value) => (Number.isInteger(value) ? general(value) : fractional(value));
}

export function timeFormatter(specifier: string | undefined, locale: string): Formatter {
  const fmt = localeFor(locale).time.format(specifier ?? "%b %d");
  return (value) => fmt(new Date(value));
}

/**
 * The in-place label template: `{category}`, `{series}`, `{value}` and
 * `{percent}` substituted, everything else literal.
 *
 * A template rather than an expression because a label is presentation, and an
 * accessor would put the value's formatting in two places — the `valueFormat`
 * specifier and the expression that already read the value.
 */
export function renderLabel(
  template: string,
  fields: { category?: string; series?: string; value?: string; percent?: string },
): string {
  return template.replace(/\{(category|series|value|percent)\}/g, (match, key: string) => {
    const replacement = fields[key as keyof typeof fields];
    return replacement === undefined ? match : replacement;
  });
}

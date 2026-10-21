import { Label } from "radix-ui";
import { useSay, useText, type WireText } from "./texts.js";

export type Unit = "day" | "week" | "month" | "quarter" | "year";

export interface Preset {
  label: WireText;
  unit: Unit;
  offset: number;
}

/** A range as its two inputs hold it: `YYYY-MM-DD`, or empty. */
export interface Range {
  from: string;
  to: string;
}

const pad = (value: number) => String(value).padStart(2, "0");
/** A day of the viewer's time zone, as a `format: date` value. */
export const dayText = (day: Date): string => `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
const day = (year: number, month: number, date: number) => new Date(year, month, date);

/** The whole `unit` holding `today`, moved by `offset` units, in the viewer's
 *  time zone; a week begins on `weekStart`. */
export function presetRange(preset: Preset, weekStart: "monday" | "sunday", today: Date): Range {
  const year = today.getFullYear();
  const month = today.getMonth();
  const date = today.getDate();
  const { unit, offset } = preset;
  switch (unit) {
    case "day":
      return { from: dayText(day(year, month, date + offset)), to: dayText(day(year, month, date + offset)) };
    case "week": {
      const back = (today.getDay() - (weekStart === "monday" ? 1 : 0) + 7) % 7;
      const start = date - back + 7 * offset;
      return { from: dayText(day(year, month, start)), to: dayText(day(year, month, start + 6)) };
    }
    case "month":
      return { from: dayText(day(year, month + offset, 1)), to: dayText(day(year, month + offset + 1, 0)) };
    case "quarter": {
      const first = Math.floor(month / 3) * 3 + 3 * offset;
      return { from: dayText(day(year, first, 1)), to: dayText(day(year, first + 3, 0)) };
    }
    case "year":
      return { from: dayText(day(year + offset, 0, 1)), to: dayText(day(year + offset, 11, 31)) };
  }
}

/** The first preset a range is exactly, or none. */
export const activePreset = (presets: Preset[], weekStart: "monday" | "sunday", range: Range, today: Date): number =>
  presets.findIndex((preset) => {
    const held = presetRange(preset, weekStart, today);
    return held.from === range.from && held.to === range.to;
  });

const parse = (text: string): Date | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return match ? day(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
};

/** Whether a range starts after it ends: what blocks a submission. */
export function rangeReversed(range: Range): boolean {
  const from = parse(range.from);
  const to = parse(range.to);
  return from !== undefined && to !== undefined && from > to;
}

/** Whether a range is longer than `count` units: it reaches the day that many
 *  units after its start. What draws a warning, never blocks. */
export function rangeLongerThan(range: Range, limit: { unit: Unit; count: number }): boolean {
  const from = parse(range.from);
  const to = parse(range.to);
  if (!from || !to) return false;
  const months = { month: 1, quarter: 3, year: 12 } as Record<string, number>;
  const end =
    limit.unit === "day" || limit.unit === "week"
      ? day(from.getFullYear(), from.getMonth(), from.getDate() + limit.count * (limit.unit === "week" ? 7 : 1))
      : day(from.getFullYear(), from.getMonth() + limit.count * months[limit.unit], from.getDate());
  return to >= end;
}

interface DateRangeProps {
  id: string;
  label: string;
  presets: Preset[];
  weekStart: "monday" | "sunday";
  value: Range;
  invalid: boolean;
  onChange: (next: Range) => void;
}

/** Two dates and the presets that set them, the one the dates equal shown on. */
export function DateRange({ id, label, presets, weekStart, value, invalid, onChange }: DateRangeProps) {
  const say = useSay();
  const text = useText();
  const today = new Date();
  const active = activePreset(presets, weekStart, value, today);
  return (
    <div data-telo-part="date-range" role="group" aria-label={label} data-invalid={invalid ? "true" : undefined}>
      {presets.length > 0 && (
        <div data-telo-part="date-range-presets">
          {presets.map((preset, index) => (
            <button
              key={index}
              data-telo-part="date-range-preset"
              type="button"
              data-state={index === active ? "on" : "off"}
              aria-pressed={index === active}
              // Computed at the click, in the viewer's time zone.
              onClick={() => onChange(presetRange(preset, weekStart, new Date()))}
            >
              {text(preset.label)}
            </button>
          ))}
        </div>
      )}
      <Label.Root data-telo-part="label" htmlFor={`${id}-from`}>
        {say("rangeFrom")}
      </Label.Root>
      <input
        data-telo-part="date-range-from"
        id={`${id}-from`}
        type="date"
        autoComplete="off"
        aria-invalid={invalid ? true : undefined}
        value={value.from}
        onChange={(event) => onChange({ ...value, from: event.target.value })}
      />
      <Label.Root data-telo-part="label" htmlFor={`${id}-to`}>
        {say("rangeTo")}
      </Label.Root>
      <input
        data-telo-part="date-range-to"
        id={`${id}-to`}
        type="date"
        autoComplete="off"
        aria-invalid={invalid ? true : undefined}
        value={value.to}
        onChange={(event) => onChange({ ...value, to: event.target.value })}
      />
    </div>
  );
}

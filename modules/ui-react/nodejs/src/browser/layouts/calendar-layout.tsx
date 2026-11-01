import { useEffect, useState } from "react";
import type { LayoutProps, LayoutRecord } from "../../contract/ui-react-layouts.js";
import { IconButton } from "../icon-button.js";
import { Empty, LevelState, MoveMenu, RecordEntry, useDrag, type Place } from "./layout-kit.js";
import { calendarPeriod, calendarStep, dayFormat, dayOf, periodOf, shifted, today, unitName, weekdayOf, written, type CalendarView, type SpanFormat } from "./periods.js";

const VIEWS: CalendarView[] = ["month", "week", "day"];

/**
 * Records on the days of a month, a week or a day. The period shown is the
 * span's: the calendar names one when it has none, and moves between periods
 * and views by asking for another. An event dragged onto a day — or moved
 * there through its "Move to" menu — is rescheduled to it, its end moved by
 * as many days and its time of day kept.
 */
export function CalendarLayout(props: LayoutProps) {
  const start = props.props.start as string;
  const end = props.props.end as string | undefined;
  const format = props.props.format as SpanFormat;
  const [view, setView] = useState<CalendarView>(props.props.period as CalendarView);
  const drag = useDrag();
  const anchor = (props.span && dayOf(props.span.from)) ?? today();
  const show = (next: CalendarView, day: number) => {
    const { first, last } = calendarPeriod(next, day);
    props.onPeriodChange(periodOf(first, last, format));
  };
  const named = props.span !== null && props.span !== undefined;
  useEffect(() => {
    if (!named) show(view, today());
  }, [named]);

  const { first, last } = calendarPeriod(view, anchor);
  const title = dayFormat(props.lang, view === "month" ? { month: "long", year: "numeric" } : view === "week" ? { month: "short", day: "numeric", year: "numeric" } : { dateStyle: "full" });
  const titleOf = (day: number) => {
    const shown = calendarPeriod(view, day);
    return view === "week" ? title.range(shown.first, shown.last) : title.day(shown.first);
  };
  const label = dayFormat(props.lang, view === "month" ? { day: "numeric" } : { weekday: "short", day: "numeric" });
  const placeLabel = dayFormat(props.lang, { month: "short", day: "numeric" });
  const weekday = dayFormat(props.lang, { weekday: "short" });

  const byKey = new Map(props.records.map((record) => [record.key, record]));
  /** The record as moving it to a day leaves it: its start on that day, its end as many days on. */
  const movedTo = (record: LayoutRecord, day: number): Record<string, unknown> | undefined => {
    const from = dayOf(record.row[start]);
    if (from === undefined || from === day) return undefined;
    const to: Record<string, unknown> = { [start]: shifted(record.row[start] as string, day - from, format) };
    if (end !== undefined && typeof record.row[end] === "string") to[end] = shifted(record.row[end] as string, day - from, format);
    return to;
  };
  const on = (day: number) =>
    props.records.filter((record) => {
      const from = dayOf(record.row[start]);
      const to = end === undefined ? from : (dayOf(record.row[end]) ?? from);
      return from !== undefined && to !== undefined && from <= day && day <= to;
    });
  const days = Array.from({ length: last - first + 1 }, (_, index) => first + index);
  const before = view === "month" ? weekdayOf(first) : 0;
  const after = view === "month" ? (7 - ((before + days.length) % 7)) % 7 : 0;
  const placesFor = (record: LayoutRecord): Place[] =>
    days.flatMap((day) => {
      const to = movedTo(record, day);
      return to ? [{ key: String(day), label: placeLabel.day(day), to }] : [];
    });

  return (
    <div data-telo-part="calendar-layout">
      <div data-telo-part="calendar-header">
        <IconButton part="calendar-prev" label={titleOf(calendarStep(view, anchor, -1))} icon="previous" onClick={() => show(view, calendarStep(view, anchor, -1))} />
        <h3 data-telo-part="calendar-title">{titleOf(anchor)}</h3>
        <IconButton part="calendar-next" label={titleOf(calendarStep(view, anchor, 1))} icon="next" onClick={() => show(view, calendarStep(view, anchor, 1))} />
        <div role="group">
          {VIEWS.map((each) => (
            <button
              key={each}
              data-telo-part="calendar-period"
              type="button"
              aria-pressed={each === view}
              onClick={() => {
                setView(each);
                show(each, anchor);
              }}
            >
              {unitName(props.lang, each)}
            </button>
          ))}
        </div>
      </div>
      <div data-telo-part="calendar-grid" style={view === "day" ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}>
        {view !== "day" &&
          Array.from({ length: 7 }, (_, index) => (
            <div key={`w${index}`} data-telo-part="calendar-weekday">
              {weekday.day(4 + index)}
            </div>
          ))}
        {Array.from({ length: before }, (_, index) => (
          <div key={`b${index}`} data-telo-part="calendar-day" aria-hidden="true" />
        ))}
        {days.map((day) => (
          <div
            key={day}
            data-telo-part="calendar-day"
            role="group"
            aria-label={placeLabel.day(day)}
            {...(props.can.move
              ? drag.target((key) => {
                  const record = byKey.get(key);
                  const to = record && movedTo(record, day);
                  if (to) props.onMove(key, to);
                })
              : {})}
          >
            <span data-telo-part="calendar-day-label">{label.day(day)}</span>
            {props.can.create && <IconButton part="record-create" label={props.words.newRecord} icon="add" onClick={() => props.onCreate({ [start]: written(day, format) })} />}
            <div role="list">
              {on(day).map((record) => (
                <RecordEntry
                  key={record.key}
                  part="calendar-event"
                  // An event over several days opens its inline form on the first of them shown.
                  record={day === Math.max(dayOf(record.row[start]) as number, first) ? record : { ...record, detail: undefined }}
                  drag={props.can.move ? drag : undefined}
                  move={props.can.move && <MoveMenu record={record} places={placesFor(record)} word={props.words.moveTo} onMove={props.onMove} />}
                />
              ))}
            </div>
          </div>
        ))}
        {Array.from({ length: after }, (_, index) => (
          <div key={`a${index}`} data-telo-part="calendar-day" aria-hidden="true" />
        ))}
      </div>
      <LevelState level={props} />
      <Empty props={props} />
    </div>
  );
}

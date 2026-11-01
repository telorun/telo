import { useEffect, useState } from "react";
import type { LayoutLevel, LayoutProps, LayoutRecord } from "../../contract/ui-react-layouts.js";
import { IconButton } from "../icon-button.js";
import { Empty, LevelEnd, LevelState, MoveMenu, RecordEntry, useDrag, type Place } from "./layout-kit.js";
import { dayFormat, dayOf, periodOf, shifted, timelineStep, timelineTicks, today, unitName, type SpanFormat, type Tick, type TimelineScale } from "./periods.js";

const SCALES: TimelineScale[] = ["day", "week", "month", "quarter"];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const TICK_FORMAT: Record<TimelineScale, Intl.DateTimeFormatOptions> = {
  day: { day: "numeric" },
  week: { month: "short", day: "numeric" },
  month: { month: "short" },
  quarter: { month: "short", year: "numeric" },
};
const TITLE_FORMAT: Record<TimelineScale, Intl.DateTimeFormatOptions> = {
  day: { month: "long", year: "numeric" },
  week: { month: "short", year: "numeric" },
  month: { year: "numeric" },
  quarter: { year: "numeric" },
};

/** A lane: the records of a group, or every record when the plan has no groups. */
interface Lane {
  label?: string;
  value?: unknown;
  level: LayoutLevel;
}

/**
 * Records as bars along time at a scale — a column a day, a week, a month or
 * a quarter — in a lane per group when the plan has groups. A bar dragged
 * onto a column is moved to start there, its end moved by as many days; one
 * dragged onto another lane takes that lane's value. Its "Move to" menu offers
 * the same places.
 */
export function TimelineLayout(props: LayoutProps) {
  const start = props.props.start as string;
  const end = props.props.end as string | undefined;
  const format = props.props.format as SpanFormat;
  const property = props.props.group as string | undefined;
  const [scale, setScale] = useState<TimelineScale>(props.props.scale as TimelineScale);
  const drag = useDrag();
  const anchor = (props.span && dayOf(props.span.from)) ?? today();
  const ticks = timelineTicks(scale, anchor);
  const show = (next: TimelineScale, day: number) => {
    const shown = timelineTicks(next, day);
    props.onPeriodChange(periodOf(shown[0].first, shown[shown.length - 1].last, format));
  };
  const named = props.span !== null && props.span !== undefined;
  useEffect(() => {
    if (!named) show(scale, today());
  }, [named]);

  const tick = dayFormat(props.lang, TICK_FORMAT[scale]);
  const title = dayFormat(props.lang, TITLE_FORMAT[scale]);
  const titleOf = (day: number) => {
    const shown = timelineTicks(scale, day);
    return title.range(shown[0].first, shown[shown.length - 1].last);
  };
  const tickLabel = (each: Tick) => (scale === "quarter" ? dayFormat(props.lang, { month: "short", year: "numeric" }).range(each.first, each.last) : tick.day(each.first));
  const columns = { gridTemplateColumns: `repeat(${ticks.length}, minmax(0, 1fr))` };
  const lanes: Lane[] = props.groups ? props.groups.map((group) => ({ label: group.heading, value: group.value, level: group })) : [{ level: props }];
  const byKey = new Map(props.records.map((record) => [record.key, record]));

  const column = (day: number | undefined) => ticks.findIndex((each) => day !== undefined && each.first <= day && day <= each.last);
  /** The record as moving it to start in a column leaves it: its end moved by as many days. */
  const startingIn = (record: LayoutRecord, at: Tick): Record<string, unknown> | undefined => {
    const from = dayOf(record.row[start]);
    if (from === undefined || (at.first <= from && from <= at.last)) return undefined;
    const to: Record<string, unknown> = { [start]: shifted(record.row[start] as string, at.first - from, format) };
    if (end !== undefined && typeof record.row[end] === "string") to[end] = shifted(record.row[end] as string, at.first - from, format);
    return to;
  };
  const placesFor = (record: LayoutRecord, lane: Lane): Place[] => [
    ...ticks.flatMap((each, index) => {
      const to = startingIn(record, each);
      return to ? [{ key: `t${index}`, label: tickLabel(each), to }] : [];
    }),
    ...(property === undefined
      ? []
      : lanes.flatMap((other, index) => (same(other.value, lane.value) ? [] : [{ key: `l${index}`, label: other.label as string, to: { [property]: other.value } }]))),
  ];

  const bar = (lane: Lane) => (record: LayoutRecord) => {
    const from = dayOf(record.row[start]);
    const until = end === undefined ? from : (dayOf(record.row[end]) ?? from);
    const first = from === undefined ? -1 : from < ticks[0].first ? 0 : column(from);
    const last = until === undefined ? -1 : until > ticks[ticks.length - 1].last ? ticks.length - 1 : column(until);
    if (first === -1 || last === -1) return null;
    return (
      <div key={record.key} style={{ gridColumn: `${first + 1} / ${last + 2}` }} role="none">
        <RecordEntry
          part="timeline-bar"
          record={record}
          drag={props.can.move ? drag : undefined}
          move={props.can.move && <MoveMenu record={record} places={placesFor(record, lane)} word={props.words.moveTo} onMove={props.onMove} />}
        />
      </div>
    );
  };

  return (
    <div data-telo-part="timeline-layout">
      <div data-telo-part="timeline-header">
        <IconButton part="timeline-prev" label={titleOf(timelineStep(scale, anchor, -1))} icon="previous" onClick={() => show(scale, timelineStep(scale, anchor, -1))} />
        <h3 data-telo-part="timeline-title">{titleOf(anchor)}</h3>
        <IconButton part="timeline-next" label={titleOf(timelineStep(scale, anchor, 1))} icon="next" onClick={() => show(scale, timelineStep(scale, anchor, 1))} />
        <div role="group">
          {SCALES.map((each) => (
            <button
              key={each}
              data-telo-part="timeline-scale"
              type="button"
              aria-pressed={each === scale}
              onClick={() => {
                setScale(each);
                show(each, anchor);
              }}
            >
              {unitName(props.lang, each)}
            </button>
          ))}
        </div>
      </div>
      <div data-telo-part="timeline-axis" style={columns}>
        {ticks.map((each, index) => (
          <div
            key={index}
            data-telo-part="timeline-tick"
            {...(props.can.move
              ? drag.target((key) => {
                  const record = byKey.get(key);
                  const to = record && startingIn(record, each);
                  if (to) props.onMove(key, to);
                })
              : {})}
          >
            {tickLabel(each)}
          </div>
        ))}
      </div>
      {lanes.map((lane, index) => (
        <section
          key={index}
          data-telo-part="timeline-lane"
          aria-label={lane.label}
          {...(props.can.move && property !== undefined
            ? drag.target((key) => {
                if (!lane.level.records.some((record) => record.key === key)) props.onMove(key, { [property]: lane.value });
              })
            : {})}
        >
          {lane.label !== undefined && <div data-telo-part="timeline-lane-label">{lane.label}</div>}
          <div data-telo-part="timeline-track" role="list" style={columns}>
            {lane.level.records.map(bar(lane))}
          </div>
          {props.groups && <LevelState level={lane.level} />}
        </section>
      ))}
      {props.groups && <LevelEnd level={props} scroll={false} word={props.words.loadMore} onEndReached={props.onEndReached} />}
      <LevelState level={props} />
      <Empty props={props} />
    </div>
  );
}

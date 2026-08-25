import { scaleBand, scaleLinear, scaleLog, scalePoint, scaleTime } from "d3-scale";
import type { AxisConfig, ScaleKind } from "./chart-resource.js";
import { type Formatter, numberFormatter, timeFormatter } from "./format-values.js";
import type { TextMetrics } from "./measure-text.js";
import { INK } from "./palette.js";
import { element, escapeText, group, round, text } from "./svg.js";
import type { Rect } from "./layout-canvas.js";

/**
 * Scales, ticks and the axis furniture.
 *
 * d3-axis is not used: it renders through a DOM selection, and there is no DOM
 * here. What it would have given is a tick loop and a text placement, both of
 * which are a dozen lines and neither of which is where the difficulty is —
 * that is the thinning, which d3-axis does not do at all.
 */

export type ContinuousScale = (value: number) => number;

export interface Band {
  /** Left edge of the slot for `key`. */
  start(key: string): number;
  width: number;
  keys: string[];
}

export function isBand(scale: ScaleKind | undefined): boolean {
  return scale === "band" || scale === "point";
}

/** Roughly one tick per 60px along the axis, which is about where formatted
 *  numbers stop colliding before thinning has to intervene. */
function targetTicks(config: AxisConfig, extent: number): number {
  return config.ticks ?? Math.max(2, Math.min(12, Math.round(extent / 60)));
}

export function formatterFor(config: AxisConfig, locale: string): Formatter {
  return config.scale === "time"
    ? timeFormatter(config.tickFormat, locale)
    : numberFormatter(config.tickFormat, locale);
}

/**
 * The tick VALUES, which have to be known before the plot rect is: a tick label
 * has to be measured to decide the axis gutter, and the gutter is what decides
 * the plot. Only the domain is needed for that, so the order works out — the
 * positions come later, from the same values.
 */
export function tickValues(
  config: AxisConfig,
  domain: [number, number],
  extent: number,
): number[] {
  const count = targetTicks(config, extent);
  const scale =
    config.scale === "log"
      ? scaleLog().domain(domain)
      : config.scale === "time"
        ? scaleTime().domain([new Date(domain[0]), new Date(domain[1])])
        : scaleLinear().domain(domain);
  const ticks = scale.ticks(count) as Array<number | Date>;
  return ticks.map((tick) => (tick instanceof Date ? tick.getTime() : tick));
}

export function continuousScale(
  config: AxisConfig,
  domain: [number, number],
  range: [number, number],
): ContinuousScale {
  if (config.scale === "log") return scaleLog().domain(domain).range(range);
  return scaleLinear().domain(domain).range(range);
}

export function bandScale(keys: string[], range: [number, number], padding: number): Band {
  const scale = scaleBand<string>().domain(keys).range(range).padding(padding);
  return {
    start: (key) => scale(key) ?? range[0],
    width: scale.bandwidth(),
    keys,
  };
}

export function pointScale(keys: string[], range: [number, number]): Band {
  const scale = scalePoint<string>().domain(keys).range(range).padding(0.5);
  return { start: (key) => scale(key) ?? range[0], width: 0, keys };
}

/**
 * Drops ticks whose labels would overlap, keeping every nth.
 *
 * Silent, and that is the decision: a tick collision is an outcome of the data
 * — how many months are in the range, how long the category names are — not a
 * defect. Erroring would make a chart fail on data it should render; drawing
 * everything produces a smear no one can read.
 */
export function thinLabels<T>(
  items: T[],
  span: (item: T) => number,
  extent: number,
  gap: number,
): T[] {
  if (items.length <= 1) return items;
  const needed = items.reduce((total, item) => total + span(item) + gap, 0);
  if (needed <= extent) return items;
  const stride = Math.ceil(needed / Math.max(extent, 1));
  return items.filter((_, index) => index % stride === 0);
}

const TICK_LENGTH = 5;
const AXIS_TITLE_GAP = 4;

export interface AxisGutters {
  left: number;
  bottom: number;
}

/** How much of the plot rect the axis furniture takes, measured rather than
 *  assumed — a y axis of six-digit values needs more than one of percentages. */
export function measureGutters(opts: {
  yLabels: string[];
  xLabels: string[];
  yTitle?: string;
  xTitle?: string;
  metrics: TextMetrics;
}): AxisGutters {
  const lineHeight = opts.metrics.ascender + opts.metrics.descender;
  const widestY = Math.max(0, ...opts.yLabels.map((label) => opts.metrics.width(label)));
  return {
    left:
      widestY + TICK_LENGTH + AXIS_TITLE_GAP * 2 + (opts.yTitle ? lineHeight + AXIS_TITLE_GAP : 0),
    bottom:
      (opts.xLabels.length ? lineHeight + TICK_LENGTH + AXIS_TITLE_GAP : 0) +
      (opts.xTitle ? lineHeight + AXIS_TITLE_GAP : 0),
  };
}

export function renderXAxis(opts: {
  plot: Rect;
  positions: Array<{ at: number; label: string }>;
  title?: string;
  metrics: TextMetrics;
}): string {
  const baseY = opts.plot.y + opts.plot.height;
  let body = element("line", {
    x1: opts.plot.x,
    y1: baseY,
    x2: opts.plot.x + opts.plot.width,
    y2: baseY,
    stroke: INK.axis,
  });
  for (const tick of opts.positions) {
    body +=
      element("line", { x1: tick.at, y1: baseY, x2: tick.at, y2: baseY + TICK_LENGTH, stroke: INK.axis }) +
      text(tick.label, {
        x: tick.at,
        y: baseY + TICK_LENGTH + AXIS_TITLE_GAP + opts.metrics.ascender,
        "text-anchor": "middle",
        fill: INK.mutedText,
      });
  }
  if (opts.title) {
    // One line below the tick labels, whether or not there were any.
    const labelBand = opts.positions.length
      ? TICK_LENGTH + AXIS_TITLE_GAP + opts.metrics.ascender + opts.metrics.descender
      : TICK_LENGTH;
    body += text(opts.title, {
      x: opts.plot.x + opts.plot.width / 2,
      y: baseY + labelBand + AXIS_TITLE_GAP + opts.metrics.ascender,
      "text-anchor": "middle",
      fill: INK.text,
      "font-weight": 600,
    });
  }
  return group({ "data-part": "axis-x" }, body);
}

export function renderYAxis(opts: {
  plot: Rect;
  positions: Array<{ at: number; label: string }>;
  title?: string;
  metrics: TextMetrics;
}): string {
  let body = element("line", {
    x1: opts.plot.x,
    y1: opts.plot.y,
    x2: opts.plot.x,
    y2: opts.plot.y + opts.plot.height,
    stroke: INK.axis,
  });
  for (const tick of opts.positions) {
    body +=
      element("line", {
        x1: opts.plot.x - TICK_LENGTH,
        y1: tick.at,
        x2: opts.plot.x,
        y2: tick.at,
        stroke: INK.axis,
      }) +
      text(tick.label, {
        x: opts.plot.x - TICK_LENGTH - AXIS_TITLE_GAP,
        // Half the ascender puts the label's optical middle on the tick, which
        // is what "aligned with the gridline" means to a reader.
        y: tick.at + opts.metrics.ascender / 2,
        "text-anchor": "end",
        fill: INK.mutedText,
      });
  }
  if (opts.title) {
    const cx = opts.plot.x - TICK_LENGTH - AXIS_TITLE_GAP * 2 - widest(opts.positions, opts.metrics);
    const cy = opts.plot.y + opts.plot.height / 2;
    body += element(
      "text",
      {
        transform: `rotate(-90 ${round(cx)} ${round(cy)})`,
        x: cx,
        y: cy,
        "text-anchor": "middle",
        fill: INK.text,
        "font-weight": 600,
      },
      escapeText(opts.title),
    );
  }
  return group({ "data-part": "axis-y" }, body);
}

function widest(positions: Array<{ label: string }>, metrics: TextMetrics): number {
  return Math.max(0, ...positions.map((tick) => metrics.width(tick.label)));
}

export function renderGridlines(opts: {
  plot: Rect;
  x?: Array<{ at: number }>;
  y?: Array<{ at: number }>;
}): string {
  let body = "";
  for (const line of opts.y ?? []) {
    body += element("line", {
      x1: opts.plot.x,
      y1: line.at,
      x2: opts.plot.x + opts.plot.width,
      y2: line.at,
      stroke: INK.grid,
    });
  }
  for (const line of opts.x ?? []) {
    body += element("line", {
      x1: line.at,
      y1: opts.plot.y,
      x2: line.at,
      y2: opts.plot.y + opts.plot.height,
      stroke: INK.grid,
    });
  }
  return body === "" ? "" : group({ "data-part": "gridlines" }, body);
}

/** Domain from the data, with either end overridden by a declared one. An
 *  empty extent (one row, or every row the same) is widened, since a zero-width
 *  domain maps every value to the same pixel.
 *
 *  A log domain is clamped HERE, once, rather than where the scale is built: the
 *  tick values and the mark positions are two consumers of the same domain, and
 *  clamping at one of them left the other reading an unclamped zero — where
 *  `scaleLog().domain([0, n]).ticks()` returns nothing at all, so the marks were
 *  placed correctly onto an axis with no ticks, no labels and no gridlines. */
export function domainFor(config: AxisConfig, values: number[]): [number, number] {
  let min = config.domain?.min ?? (values.length ? Math.min(...values) : 0);
  let max = config.domain?.max ?? (values.length ? Math.max(...values) : 1);
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  if (config.scale === "log") {
    // A log scale cannot cross or touch zero, and a value at or below it has no
    // position on one. Six decades below the top is an arbitrary floor, and a
    // visible one: it is where the axis starts rather than a silent NaN.
    if (min <= 0) min = Math.max(Number.MIN_VALUE, (max > 0 ? max : 1) / 1e6);
    if (max <= min) max = min * 10;
  }
  return [min, max];
}

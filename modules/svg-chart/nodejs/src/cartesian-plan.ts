import type { CartesianResource, Canvas } from "./chart-resource.js";
import type { ResourceContext } from "@telorun/sdk";
import { KeyGuard, evaluate, requireKey, requireNumber, type RowScope } from "./encode-rows.js";
import { domainFor, formatterFor, isBand, tickValues } from "./axes.js";
import type { LegendEntry } from "./layout-canvas.js";

/**
 * What the four charts with axes derive from their rows, before anything is
 * placed.
 *
 * Shared because the derivation is identical: read both accessors and the
 * series accessor per row, decide whether each axis is categorical or
 * continuous, and format the ticks. What differs between a bar and a scatter
 * begins at drawing, not here.
 */

export interface Mark {
  /** Categorical position along x, when that axis is a band; else "". */
  xKey: string;
  /** Categorical position along y, when that axis is a band; else "". */
  yKey: string;
  x: number;
  y: number;
  series: string;
  index: number;
}

export interface AxisPlan {
  categorical: boolean;
  /** Distinct values in first-seen order, for a band axis. */
  keys: string[];
  domain: [number, number];
  ticks: number[];
  labels: string[];
}

export interface CartesianPlan {
  marks: Mark[];
  seriesNames: string[];
  /** The axis carrying the magnitude — the one a bar's length runs along and a
   *  stack accumulates on. The other is the categorical one. */
  valueAxis: "x" | "y";
  x: AxisPlan;
  y: AxisPlan;
}

export interface PlanOptions {
  /** Which axis carries the categories when the author declares no scale. Bars
   *  band one axis and measure along the other, and which is which is what
   *  `orientation` decides; every other cartesian chart is continuous on both. */
  bandAxis?: "x" | "y";
  /** A chart drawing one mark per (position, series) pair refuses a duplicate;
   *  a scatter draws the cloud. */
  uniquePairs: boolean;
  /** Bars and bands are read as a length from zero, so the VALUE domain reaches
   *  it even when the data does not — a bar chart truncated at its smallest
   *  value exaggerates every difference on it. A scatter and a line are read as
   *  positions, where the same choice throws away resolution. */
  baselineZero?: boolean;
  /** Stacked charts are drawn against cumulative totals, so the domain has to
   *  cover the tallest stack rather than the tallest single row. */
  stacked?: boolean;
}

export function planCartesian(
  ctx: ResourceContext,
  resource: CartesianResource,
  rows: unknown[],
  scope: RowScope,
  canvas: Canvas,
  describe: string,
  opts: PlanOptions,
): CartesianPlan {
  const xScale = resource.x.scale ?? (opts.bandAxis === "x" ? "band" : "linear");
  const yScale = resource.y.scale ?? (opts.bandAxis === "y" ? "band" : "linear");
  const xCategorical = isBand(xScale);
  const yCategorical = isBand(yScale);

  const guard = opts.uniquePairs ? new KeyGuard(describe, "x/series pair") : undefined;
  const seriesNames: string[] = [];
  const xKeys: string[] = [];
  const yKeys: string[] = [];
  const marks: Mark[] = rows.map((row, index) => {
    const series = resource.series
      ? requireKey(evaluate(ctx, resource.series, row, index, scope), index, "series", describe)
      : "";
    if (!seriesNames.includes(series)) seriesNames.push(series);

    const rawX = evaluate(ctx, resource.x.value, row, index, scope);
    const xKey = xCategorical ? requireKey(rawX, index, "x.value", describe) : "";
    if (xCategorical && !xKeys.includes(xKey)) xKeys.push(xKey);
    const x = xCategorical ? 0 : coerce(rawX, index, "x.value", describe, xScale);

    const rawY = evaluate(ctx, resource.y.value, row, index, scope);
    const yKey = yCategorical ? requireKey(rawY, index, "y.value", describe) : "";
    if (yCategorical && !yKeys.includes(yKey)) yKeys.push(yKey);
    const y = yCategorical ? 0 : coerce(rawY, index, "y.value", describe, yScale);

    // The categorical axis identifies the position; the other one is the value
    // being compared, so it is never part of the key.
    const position = xCategorical ? xKey : yCategorical ? yKey : x;
    guard?.claim(`${position} / ${series}`, index);
    return { xKey, yKey, x, y, series, index };
  });

  // Whichever axis is NOT the band carries the magnitude, so that is the one a
  // stack accumulates along and the one a baseline is pinned on. With neither
  // banded — a line, a scatter — the vertical one is the value by convention,
  // which is what makes `baselineZero` and stacking mean the usual thing.
  const valueAxis: "x" | "y" = xCategorical ? "y" : yCategorical ? "x" : "y";
  const values = opts.stacked
    ? stackTotals(marks, valueAxis)
    : marks.map((mark) => (valueAxis === "y" ? mark.y : mark.x));
  if (opts.baselineZero) values.push(0);

  const xValues = valueAxis === "y" ? marks.map((mark) => mark.x) : values;
  const yValues = valueAxis === "y" ? values : marks.map((mark) => mark.y);

  return {
    marks,
    seriesNames,
    valueAxis,
    x: axisPlan(resource, "x", xCategorical, xKeys, xValues, canvas.width, xScale),
    y: axisPlan(resource, "y", yCategorical, yKeys, yValues, canvas.height, yScale),
  };
}

/** The length of each stack, which is what the value domain has to cover once
 *  the parts are drawn on top of one another. */
function stackTotals(marks: Mark[], valueAxis: "x" | "y"): number[] {
  const totals = new Map<string, number>();
  for (const mark of marks) {
    const key = valueAxis === "y" ? mark.xKey || String(mark.x) : mark.yKey || String(mark.y);
    totals.set(key, (totals.get(key) ?? 0) + (valueAxis === "y" ? mark.y : mark.x));
  }
  return [...totals.values()];
}

/** A time scale reads an ISO string as well as epoch milliseconds, which is
 *  what arrives from a database driver or a JSON payload. */
function coerce(
  value: unknown,
  index: number,
  accessor: string,
  describe: string,
  scale: string,
): number {
  if (scale === "time" && typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return requireNumber(value, index, accessor, describe);
}

function axisPlan(
  resource: CartesianResource,
  which: "x" | "y",
  categorical: boolean,
  keys: string[],
  values: number[],
  extent: number,
  scale: string,
): AxisPlan {
  const config = { ...resource[which], scale: scale as never };
  if (categorical) {
    return { categorical: true, keys, domain: [0, 1], ticks: [], labels: keys };
  }
  const domain = domainFor(config, values);
  const ticks = tickValues(config, domain, extent);
  const format = formatterFor(config, resource.locale ?? "en-US");
  return { categorical: false, keys: [], domain, ticks, labels: ticks.map(format) };
}

export function cartesianLegend(
  plan: CartesianPlan,
  color: (index: number) => string,
): LegendEntry[] {
  // A chart with no `series` has one unnamed series, which a legend of one
  // blank entry describes to nobody.
  if (plan.seriesNames.length <= 1 && plan.seriesNames[0] === "") return [];
  return plan.seriesNames.map((name, index) => ({ label: name, color: color(index) }));
}

export function cartesianStrings(plan: CartesianPlan, resource: CartesianResource): string[] {
  return [
    ...plan.x.labels,
    ...plan.y.labels,
    ...(resource.x.title ? [resource.x.title] : []),
    ...(resource.y.title ? [resource.y.title] : []),
  ];
}

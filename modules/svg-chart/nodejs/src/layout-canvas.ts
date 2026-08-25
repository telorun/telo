import type { Canvas, LegendConfig } from "./chart-resource.js";
import { INK } from "./palette.js";
import { element, group, round, text } from "./svg.js";
import type { TextMetrics } from "./measure-text.js";

/**
 * Splitting the canvas into a title band, a legend band and what is left for
 * the plot.
 *
 * Shared by every chart type because the title and the legend are laid out
 * identically for all of them, and because both consume space the plot does not
 * get — which is the only reason the plot cannot simply be the canvas minus its
 * margins.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LegendEntry {
  label: string;
  color: string;
}

const SWATCH = 10;
const SWATCH_GAP = 6;
const ENTRY_GAP = 16;
const TITLE_SCALE = 1.35;

export interface Frame {
  /** What is left after the title and the legend. */
  plot: Rect;
  /** Drawn before the marks, so nothing overlaps them. */
  furniture: string;
}

export function frameChart(opts: {
  canvas: Canvas;
  title?: string;
  legend?: LegendConfig;
  entries: LegendEntry[];
  metrics: TextMetrics;
}): Frame {
  const { canvas, metrics } = opts;
  const { margin } = canvas;
  let top = margin.top;
  let furniture = "";

  const titleSize = canvas.fontSize * TITLE_SCALE;
  if (opts.title) {
    const height = titleSize * 1.5;
    furniture += text(opts.title, {
      x: margin.left,
      // The baseline sits an ascender below the band's top, scaled from the
      // measured ascender at the base size.
      y: top + (metrics.ascender / canvas.fontSize) * titleSize,
      "font-size": titleSize,
      "font-weight": 600,
      fill: INK.text,
    });
    top += height;
  }

  const placement = opts.entries.length === 0 ? "none" : (opts.legend?.placement ?? "right");
  const available: Rect = {
    x: margin.left,
    y: top,
    width: canvas.width - margin.left - margin.right,
    height: canvas.height - top - margin.bottom,
  };

  if (placement === "none") return { plot: available, furniture };

  const lineHeight = metrics.ascender + metrics.descender + metrics.lineGap;
  const headingHeight = opts.legend?.title ? lineHeight * 1.2 : 0;

  if (placement === "right") {
    const widest = Math.max(
      opts.legend?.title ? metrics.width(opts.legend.title) : 0,
      ...opts.entries.map((entry) => SWATCH + SWATCH_GAP + metrics.width(entry.label)),
    );
    // Capped at 40% of the plot: a long series name must cost the legend its
    // width, not the chart its plot area.
    const width = Math.min(widest + ENTRY_GAP, available.width * 0.4);
    furniture += verticalLegend({
      x: available.x + available.width - width + ENTRY_GAP,
      y: available.y,
      entries: opts.entries,
      title: opts.legend?.title,
      lineHeight,
      metrics,
      canvas,
      headingHeight,
    });
    return {
      plot: { ...available, width: available.width - width },
      furniture,
    };
  }

  const rows = wrapEntries(opts.entries, available.width, metrics);
  const height = headingHeight + rows.length * lineHeight + ENTRY_GAP / 2;
  furniture += horizontalLegend({
    x: available.x,
    y: available.y + available.height - height,
    rows,
    title: opts.legend?.title,
    lineHeight,
    metrics,
    canvas,
    headingHeight,
  });
  return { plot: { ...available, height: available.height - height }, furniture };
}

function swatchAndLabel(
  x: number,
  baseline: number,
  entry: LegendEntry,
  canvas: Canvas,
): string {
  return (
    element("rect", {
      x,
      y: baseline - SWATCH,
      width: SWATCH,
      height: SWATCH,
      rx: 2,
      fill: entry.color,
    }) +
    text(entry.label, {
      x: x + SWATCH + SWATCH_GAP,
      y: baseline,
      fill: INK.text,
      "font-size": canvas.fontSize,
    })
  );
}

function verticalLegend(opts: {
  x: number;
  y: number;
  entries: LegendEntry[];
  title?: string;
  lineHeight: number;
  headingHeight: number;
  metrics: TextMetrics;
  canvas: Canvas;
}): string {
  let body = "";
  let baseline = opts.y + opts.metrics.ascender;
  if (opts.title) {
    body += text(opts.title, {
      x: opts.x,
      y: baseline,
      fill: INK.mutedText,
      "font-weight": 600,
      "font-size": opts.canvas.fontSize,
    });
    baseline += opts.headingHeight;
  }
  for (const entry of opts.entries) {
    body += swatchAndLabel(opts.x, baseline, entry, opts.canvas);
    baseline += opts.lineHeight;
  }
  return group({ "data-part": "legend" }, body);
}

function horizontalLegend(opts: {
  x: number;
  y: number;
  rows: LegendEntry[][];
  title?: string;
  lineHeight: number;
  headingHeight: number;
  metrics: TextMetrics;
  canvas: Canvas;
}): string {
  let body = "";
  let baseline = opts.y + opts.metrics.ascender;
  if (opts.title) {
    body += text(opts.title, {
      x: opts.x,
      y: baseline,
      fill: INK.mutedText,
      "font-weight": 600,
      "font-size": opts.canvas.fontSize,
    });
    baseline += opts.headingHeight;
  }
  for (const row of opts.rows) {
    let x = opts.x;
    for (const entry of row) {
      body += swatchAndLabel(x, baseline, entry, opts.canvas);
      x += SWATCH + SWATCH_GAP + opts.metrics.width(entry.label) + ENTRY_GAP;
    }
    baseline += opts.lineHeight;
  }
  return group({ "data-part": "legend" }, body);
}

/** Entries flow across the available width and wrap, so a chart with twelve
 *  series grows its legend downward instead of running off the canvas. */
function wrapEntries(
  entries: LegendEntry[],
  width: number,
  metrics: TextMetrics,
): LegendEntry[][] {
  const rows: LegendEntry[][] = [[]];
  let used = 0;
  for (const entry of entries) {
    const entryWidth = SWATCH + SWATCH_GAP + metrics.width(entry.label) + ENTRY_GAP;
    if (used > 0 && used + entryWidth > width) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1]!.push(entry);
    used += entryWidth;
  }
  return rows;
}

/** Centre of a rect, which every angular chart needs and nothing else does
 *  differently. */
export function centerOf(rect: Rect): { cx: number; cy: number; radius: number } {
  return {
    cx: rect.x + rect.width / 2,
    cy: rect.y + rect.height / 2,
    radius: Math.max(0, Math.min(rect.width, rect.height) / 2),
  };
}

export function translate(rect: Rect): string {
  return `translate(${round(rect.x)},${round(rect.y)})`;
}

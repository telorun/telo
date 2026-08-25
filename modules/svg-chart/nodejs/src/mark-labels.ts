import type { CartesianResource, Labelled } from "./chart-resource.js";
import type { CartesianPlan, Mark } from "./cartesian-plan.js";
import { numberFormatter, renderLabel } from "./format-values.js";
import { INK } from "./palette.js";
import { text } from "./svg.js";

/**
 * Labels drawn on the marks themselves, for the charts that have a point to
 * anchor one to.
 *
 * Shared rather than per chart because the template, the value formatting and
 * the locale are the same three things every time; what differs is only where
 * the label goes, which is the caller's to decide because only it knows what it
 * drew.
 *
 * `{percent}` is deliberately absent here: on a pie a slice's share of the total
 * is the thing being read, while on an axis chart there is no single total a
 * percentage would be of. An unsupported token is left literal, so it shows up
 * on the chart rather than silently rendering as nothing.
 */

export interface MarkLabel {
  /** Index of the row this labels, so a caller matches it to what it drew. */
  index: number;
  text: string;
}

export function markLabels(
  resource: CartesianResource & Labelled,
  plan: CartesianPlan,
  valueOf: (mark: Mark) => number,
): MarkLabel[] {
  const template = resource.labels?.format;
  if (!template) return [];
  const locale = resource.locale ?? "en-US";
  const format = numberFormatter(resource.labels?.valueFormat, locale);
  return plan.marks.map((mark) => ({
    index: mark.index,
    text: renderLabel(template, {
      category: plan.valueAxis === "y" ? mark.xKey : mark.yKey,
      series: mark.series,
      value: format(valueOf(mark)),
    }),
  }));
}

/** One label placed at a point the caller chose. Goes through the module's
 *  single text builder, so the escaping rule stays in one place. */
export function drawMarkLabel(
  label: MarkLabel,
  at: { x: number; y: number; anchor: "start" | "middle" | "end" },
): string {
  return text(label.text, { x: at.x, y: at.y, "text-anchor": at.anchor, fill: INK.text });
}

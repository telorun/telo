import { arc, pie } from "d3-shape";
import { InvokeError, type ResourceContext } from "@telorun/sdk";
import { ChartBase, type DrawContext } from "./chart-base.js";
import type { Canvas, PieResource } from "./chart-resource.js";
import { DATA_INVALID, KeyGuard, evaluate, requireKey, requireNumber, type RowScope } from "./encode-rows.js";
import { numberFormatter, renderLabel } from "./format-values.js";
import { centerOf, type LegendEntry } from "./layout-canvas.js";
import { INK } from "./palette.js";
import { element, group, round, text } from "./svg.js";

/**
 * Pie and donut — one slice per row, sized by its share of the total.
 *
 * One class for both: the hole is the whole difference, and a donut with an
 * inner radius of zero IS a pie. `SvgChart.Donut` extends `SvgChart.Pie` in the
 * manifest for the same reason.
 */

interface Slice {
  category: string;
  value: number;
}

interface PiePlan {
  slices: Slice[];
  total: number;
  labels: string[];
}

export class PieChart extends ChartBase<PieResource, PiePlan> {
  constructor(
    ctx: ResourceContext,
    resource: PieResource,
    private readonly kind: string,
    private readonly defaultInnerRadius: number,
  ) {
    super(ctx, resource);
  }

  protected get describe(): string {
    return `SvgChart.${this.kind} "${this.resource.metadata.name}"`;
  }

  protected plan(rows: unknown[], scope: RowScope): PiePlan {
    const guard = new KeyGuard(this.describe, "category");
    const slices: Slice[] = rows.map((row, index) => {
      const category = requireKey(
        evaluate(this.ctx, this.resource.category, row, index, scope),
        index,
        "category",
        this.describe,
      );
      guard.claim(category, index);
      const value = requireNumber(
        evaluate(this.ctx, this.resource.value, row, index, scope),
        index,
        "value",
        this.describe,
      );
      if (value < 0) {
        throw new InvokeError(
          DATA_INVALID,
          `${this.describe}: 'value' produced ${value} for row ${index}; a slice cannot have a ` +
            `negative share of a total. Split the data into two charts, or plot it as bars.`,
        );
      }
      return { category, value };
    });

    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    return { slices, total, labels: this.labelsFor(slices, total) };
  }

  private labelsFor(slices: Slice[], total: number): string[] {
    const template = this.resource.labels?.format;
    if (!template) return slices.map(() => "");
    const value = numberFormatter(this.resource.labels?.valueFormat, this.resource.locale ?? "en-US");
    const percent = numberFormatter(".0%", this.resource.locale ?? "en-US");
    return slices.map((slice) =>
      renderLabel(template, {
        category: slice.category,
        value: value(slice.value),
        percent: total > 0 ? percent(slice.value / total) : percent(0),
      }),
    );
  }

  protected strings(plan: PiePlan): string[] {
    return plan.labels;
  }

  protected legendEntries(plan: PiePlan, color: (index: number) => string): LegendEntry[] {
    return plan.slices.map((slice, index) => ({ label: slice.category, color: color(index) }));
  }

  protected draw({ plan, plot, color, metrics }: DrawContext<PiePlan>): string {
    if (plan.total <= 0) return "";
    const { cx, cy, radius } = centerOf(plot);
    if (radius <= 0) return "";

    // The label ring lives outside the slices, so the slices give up the room
    // it needs rather than the labels overlapping them.
    const labelled = plan.labels.some((label) => label !== "");
    const outer = labelled ? radius * 0.78 : radius * 0.95;
    const inner = outer * (this.resource.innerRadius ?? this.defaultInnerRadius);

    const layout = pie<Slice>()
      .value((slice) => slice.value)
      .sortValues(null);
    const shape = arc<{ startAngle: number; endAngle: number }>().innerRadius(inner).outerRadius(outer);

    let body = "";
    let labels = "";
    layout(plan.slices).forEach((wedge, index) => {
      const path = shape({ startAngle: wedge.startAngle, endAngle: wedge.endAngle });
      if (path) {
        body += element("path", {
          d: path,
          transform: `translate(${round(cx)},${round(cy)})`,
          fill: color(index),
          stroke: "#FFFFFF",
          "stroke-width": 1,
        });
      }
      const label = plan.labels[index];
      if (label) labels += this.leaderLabel(wedge, label, { cx, cy, outer, ascender: metrics.ascender });
    });

    return group({ "data-part": "slices" }, body) + (labels ? group({ "data-part": "labels" }, labels) : "");
  }

  /** A line from the slice's edge out to its label, so a thin slice's label is
   *  still attached to something. */
  private leaderLabel(
    wedge: { startAngle: number; endAngle: number },
    label: string,
    geom: { cx: number; cy: number; outer: number; ascender: number },
  ): string {
    const mid = (wedge.startAngle + wedge.endAngle) / 2 - Math.PI / 2;
    const [sx, sy] = [geom.cx + Math.cos(mid) * geom.outer, geom.cy + Math.sin(mid) * geom.outer];
    const [bx, by] = [geom.cx + Math.cos(mid) * (geom.outer + 10), geom.cy + Math.sin(mid) * (geom.outer + 10)];
    const right = Math.cos(mid) >= 0;
    const ex = bx + (right ? 6 : -6);
    return (
      element("polyline", {
        points: `${round(sx)},${round(sy)} ${round(bx)},${round(by)} ${round(ex)},${round(by)}`,
        fill: "none",
        stroke: INK.axis,
        "stroke-width": 1,
      }) +
      text(label, {
        x: ex + (right ? 3 : -3),
        y: by + geom.ascender / 2,
        "text-anchor": right ? "start" : "end",
        fill: INK.text,
      })
    );
  }
}


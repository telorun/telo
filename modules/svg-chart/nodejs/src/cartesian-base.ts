import type { ResourceContext } from "@telorun/sdk";
import {
  bandScale,
  continuousScale,
  type Band,
  type ContinuousScale,
  measureGutters,
  pointScale,
  renderGridlines,
  renderXAxis,
  renderYAxis,
  thinLabels,
} from "./axes.js";
import { ChartBase, type DrawContext } from "./chart-base.js";
import type { Canvas, CartesianResource } from "./chart-resource.js";
import type { RowScope } from "./encode-rows.js";
import { cartesianLegend, cartesianStrings, planCartesian, type CartesianPlan, type PlanOptions } from "./cartesian-plan.js";
import type { LegendEntry, Rect } from "./layout-canvas.js";

/**
 * The axis furniture, laid out once for the four chart types that have it.
 *
 * A subclass gets the plot rect AFTER the gutters have been taken out of it and
 * the scales built over what is left, so what it implements is only the marks.
 */

export interface PlotFrame {
  /** The rect the marks are drawn in — the plot minus the axis gutters. */
  area: Rect;
  x: { band?: Band; scale?: ContinuousScale };
  y: { band?: Band; scale?: ContinuousScale };
}

const BAND_PADDING = 0.2;

export abstract class CartesianChart<
  Resource extends CartesianResource,
  Plan extends CartesianPlan = CartesianPlan,
> extends ChartBase<Resource, Plan> {
  constructor(
    ctx: ResourceContext,
    resource: Resource,
    private readonly kind: string,
    private readonly planOptions: PlanOptions,
  ) {
    super(ctx, resource);
  }

  protected get describe(): string {
    return `SvgChart.${this.kind} "${this.resource.metadata.name}"`;
  }

  protected plan(rows: unknown[], scope: RowScope, canvas: Canvas): Plan {
    return planCartesian(
      this.ctx,
      this.resource,
      rows,
      scope,
      canvas,
      this.describe,
      this.planOptions,
    ) as Plan;
  }

  protected strings(plan: Plan): string[] {
    return [...cartesianStrings(plan, this.resource), ...this.markStrings(plan)];
  }

  /** Labels a subclass draws on the marks themselves — measured with everything
   *  else, since the batch has to name every string the chart will draw. */
  protected markStrings(plan: Plan): string[] {
    return [];
  }

  protected legendEntries(plan: Plan, color: (index: number) => string): LegendEntry[] {
    return cartesianLegend(plan, color);
  }

  protected draw(context: DrawContext<Plan>): string {
    const { plan, plot, metrics } = context;
    const gutters = measureGutters({
      yLabels: plan.y.labels,
      xLabels: plan.x.labels,
      yTitle: this.resource.y.title,
      xTitle: this.resource.x.title,
      metrics,
    });

    const area: Rect = {
      x: plot.x + gutters.left,
      y: plot.y,
      width: Math.max(0, plot.width - gutters.left),
      height: Math.max(0, plot.height - gutters.bottom),
    };

    const frame: PlotFrame = {
      area,
      x: axisScale(
        plan.x,
        this.resource.x.scale ?? (this.planOptions.bandAxis === "x" ? "band" : "linear"),
        [area.x, area.x + area.width],
      ),
      // Vertical axes run upward, so the range is inverted.
      y: axisScale(
        plan.y,
        this.resource.y.scale ?? (this.planOptions.bandAxis === "y" ? "band" : "linear"),
        [area.y + area.height, area.y],
      ),
    };

    const xTicks = tickPositions(plan.x, frame.x, metrics, area.width, "x");
    const yTicks = tickPositions(plan.y, frame.y, metrics, area.height, "y");

    const grid = renderGridlines({
      plot: area,
      x: this.resource.gridlines?.x ? xTicks : undefined,
      y: this.resource.gridlines?.y ? yTicks : undefined,
    });

    return (
      grid +
      this.drawMarks(context, frame) +
      renderXAxis({
        plot: area,
        positions: xTicks,
        title: this.resource.x.title,
        metrics,
      }) +
      renderYAxis({
        plot: area,
        positions: yTicks,
        title: this.resource.y.title,
        metrics,
      })
    );
  }

  protected abstract drawMarks(context: DrawContext<Plan>, frame: PlotFrame): string;
}

function axisScale(
  plan: CartesianPlan["x"],
  scale: string,
  range: [number, number],
): { band?: Band; scale?: ContinuousScale } {
  if (plan.categorical) {
    const ordered: [number, number] = range[0] <= range[1] ? range : [range[1], range[0]];
    return {
      band:
        scale === "point"
          ? pointScale(plan.keys, ordered)
          : bandScale(plan.keys, ordered, BAND_PADDING),
    };
  }
  return { scale: continuousScale({ value: null, scale: scale as never }, plan.domain, range) };
}

/** Tick positions, thinned so labels that would collide are dropped. Silent by
 *  design — a collision is an outcome of the data, not a defect. */
function tickPositions(
  plan: CartesianPlan["x"],
  axis: { band?: Band; scale?: ContinuousScale },
  metrics: { width(value: string): number; ascender: number; descender: number },
  extent: number,
  which: "x" | "y",
): Array<{ at: number; label: string }> {
  const all = plan.categorical
    ? plan.keys.map((key) => ({
        at: (axis.band?.start(key) ?? 0) + (axis.band?.width ?? 0) / 2,
        label: key,
      }))
    : plan.ticks.map((tick, index) => ({
        at: axis.scale?.(tick) ?? 0,
        label: plan.labels[index] ?? "",
      }));

  const span =
    which === "x"
      ? (tick: { label: string }) => metrics.width(tick.label)
      : () => metrics.ascender + metrics.descender;
  return thinLabels(all, span, extent, which === "x" ? 8 : 4);
}

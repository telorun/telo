import { area } from "d3-shape";
import type { ResourceContext } from "@telorun/sdk";
import { CartesianChart, type PlotFrame } from "./cartesian-base.js";
import type { DrawContext } from "./chart-base.js";
import type { AreaResource } from "./chart-resource.js";
import type { CartesianPlan } from "./cartesian-plan.js";
import { CURVES, seriesPaths } from "./line-chart.js";
import { element, group } from "./svg.js";

/**
 * Filled bands between a baseline and each series' values, optionally stacked.
 *
 * Stacking is done here rather than through d3-shape's stack generator: that
 * one takes a wide table (one row per position, one column per series), and
 * these rows are long (one row per position and series). Reshaping into wide
 * form to hand it over and back is more code than accumulating a running
 * baseline per position.
 */
class AreaChart extends CartesianChart<AreaResource> {
  constructor(ctx: ResourceContext, resource: AreaResource) {
    super(ctx, resource, "Area", {
      uniquePairs: true,
      baselineZero: true,
      stacked: resource.stacked ?? false,
    });
  }

  protected drawMarks({ plan, color }: DrawContext<CartesianPlan>, frame: PlotFrame): string {
    const scale = frame.y.scale;
    if (!scale) return "";
    const baseline = scale(plan.y.domain[0] <= 0 && plan.y.domain[1] >= 0 ? 0 : plan.y.domain[0]);
    const stacked = this.resource.stacked ?? false;

    const shape = area<{ x: number; y0: number; y1: number }>()
      .x((point) => point.x)
      .y0((point) => point.y0)
      .y1((point) => point.y1)
      .curve(CURVES[this.resource.curve ?? "linear"]);

    // Keyed by horizontal position, so each series stacks on the total drawn
    // beneath it at that position rather than on the previous series overall.
    const below = new Map<number, number>();
    let body = "";
    for (const { index, points } of seriesPaths(plan, frame)) {
      if (points.length === 0) continue;
      const banded = points.map(([x, y]) => {
        if (!stacked) return { x, y0: baseline, y1: y };
        const base = below.get(x) ?? baseline;
        // The value's own height above the baseline, re-applied on top of what
        // is already stacked at this position.
        const height = baseline - y;
        const top = base - height;
        below.set(x, top);
        return { x, y0: base, y1: top };
      });
      const path = shape(banded);
      if (path) {
        body += element("path", {
          d: path,
          fill: color(index),
          "fill-opacity": this.resource.fillOpacity ?? 0.75,
          stroke: color(index),
          "stroke-width": 1,
        });
      }
    }
    return group({ "data-part": "areas" }, body);
  }
}

export function register(): void {}

export async function create(resource: AreaResource, ctx: ResourceContext): Promise<AreaChart> {
  return new AreaChart(ctx, resource);
}

import { curveBasis, curveLinear, curveMonotoneX, curveNatural, curveStepAfter, line } from "d3-shape";
import type { CurveFactory } from "d3-shape";
import type { ResourceContext } from "@telorun/sdk";
import { CartesianChart, type PlotFrame } from "./cartesian-base.js";
import type { DrawContext } from "./chart-base.js";
import type { CurveName, LineResource } from "./chart-resource.js";
import type { CartesianPlan, Mark } from "./cartesian-plan.js";
import { drawMarkLabel, markLabels } from "./mark-labels.js";
import { element, group } from "./svg.js";

/** How points are joined. `monotone` is the one worth knowing: it smooths
 *  without inventing peaks between the points, which is what an unconstrained
 *  spline does and what makes a smoothed chart lie. */
export const CURVES: Record<CurveName, CurveFactory> = {
  linear: curveLinear,
  monotone: curveMonotoneX,
  step: curveStepAfter,
  natural: curveNatural,
  basis: curveBasis,
};

/** Marks grouped by series and ordered along the horizontal axis, which is what
 *  makes a path rather than a scribble: rows arrive in whatever order the query
 *  returned them. */
export function seriesPaths(
  plan: CartesianPlan,
  frame: PlotFrame,
): Array<{ series: string; index: number; points: Array<[number, number]> }> {
  const positionOf = (mark: Mark): number =>
    frame.x.band
      ? frame.x.band.start(mark.xKey) + frame.x.band.width / 2
      : (frame.x.scale?.(mark.x) ?? 0);

  return plan.seriesNames.map((series, index) => {
    const points = plan.marks
      .filter((mark) => mark.series === series)
      .map((mark): { at: number; point: [number, number] } => ({
        at: frame.x.band ? plan.x.keys.indexOf(mark.xKey) : mark.x,
        point: [positionOf(mark), frame.y.scale?.(mark.y) ?? 0],
      }))
      .sort((left, right) => left.at - right.at)
      .map((entry) => entry.point);
    return { series, index, points };
  });
}

class LineChart extends CartesianChart<LineResource> {
  constructor(ctx: ResourceContext, resource: LineResource) {
    super(ctx, resource, "Line", { uniquePairs: true });
  }

  protected markStrings(plan: CartesianPlan): string[] {
    return markLabels(this.resource, plan, (mark) => mark.y).map((label) => label.text);
  }

  protected drawMarks(context: DrawContext<CartesianPlan>, frame: PlotFrame): string {
    const { plan, color, metrics } = context;
    if (!frame.y.scale) return "";
    const shape = line<[number, number]>()
      .x((point) => point[0])
      .y((point) => point[1])
      .curve(CURVES[this.resource.curve ?? "linear"]);

    // Keyed by the point a mark landed on, because a path's points are sorted
    // along the axis and no longer in row order.
    const labels = new Map(
      markLabels(this.resource, plan, (mark) => mark.y).map((label) => [label.index, label]),
    );
    let placed = "";
    for (const mark of plan.marks) {
      const label = labels.get(mark.index);
      if (!label) continue;
      const x = frame.x.band
        ? frame.x.band.start(mark.xKey) + frame.x.band.width / 2
        : (frame.x.scale?.(mark.x) ?? 0);
      placed += drawMarkLabel(label, {
        x,
        y: (frame.y.scale?.(mark.y) ?? 0) - metrics.descender - 4,
        anchor: "middle",
      });
    }

    let body = "";
    let dots = "";
    for (const { index, points } of seriesPaths(plan, frame)) {
      if (points.length === 0) continue;
      const path = shape(points);
      if (path) {
        body += element("path", {
          d: path,
          fill: "none",
          stroke: color(index),
          "stroke-width": this.resource.strokeWidth ?? 2,
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
        });
      }
      if (this.resource.points ?? false) {
        for (const [x, y] of points) {
          dots += element("circle", { cx: x, cy: y, r: 3, fill: color(index) });
        }
      }
    }
    return (
      group({ "data-part": "lines" }, body) +
      (dots ? group({ "data-part": "points" }, dots) : "") +
      (placed ? group({ "data-part": "labels" }, placed) : "")
    );
  }
}

export function register(): void {}

export async function create(resource: LineResource, ctx: ResourceContext): Promise<LineChart> {
  return new LineChart(ctx, resource);
}
